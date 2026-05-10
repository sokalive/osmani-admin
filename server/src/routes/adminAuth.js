import { Router } from 'express'
import * as billing from '../billingStore.js'
import * as authStore from '../adminAuthStore.js'
import { adminAuthAudit } from '../lib/adminAuthAudit.js'
import { signAdminJwt, verifyAdminJwt } from '../lib/adminJwt.js'
import { sendAdminOtpEmail } from '../lib/resendOtpMail.js'
import { isAdminPanelAuthRequired } from '../middleware/adminPanelAuthGate.js'

export const adminAuthRouter = Router()

const OTP_PENDING_TYP = 'otp_pending'

/** --- Simple in-memory rate limits (per process) --- */
const loginAttempts = new Map()
const otpSends = new Map()
const otpVerifyFails = new Map()
const locks = new Map()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim()
}

function lockedUntil(key) {
  const u = locks.get(key)
  return u != null && u > Date.now() ? u : null
}

function setLock(key, ms) {
  locks.set(key, Date.now() + ms)
}

function pruneBucket(map, key, windowMs, max) {
  const now = Date.now()
  let arr = map.get(key) || []
  arr = arr.filter((t) => now - t < windowMs)
  if (arr.length >= max) return false
  arr.push(now)
  map.set(key, arr)
  return true
}

function bearerPayload(req) {
  const auth = String(req.headers.authorization ?? '')
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  return verifyAdminJwt(m[1].trim())
}

async function attachAdminReq(req, res, next) {
  try {
    if (!isAdminPanelAuthRequired()) {
      return res.status(503).json({ ok: false, error: 'ADMIN_PANEL_AUTH_REQUIRED is not enabled on the server' })
    }
    const payload = bearerPayload(req)
    if (!payload?.sub || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid session' })
    }
    const rawFp = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    if (!rawFp || authStore.hashAdminDeviceFingerprint(rawFp) !== payload.fp) {
      return res.status(401).json({ ok: false, error: 'Device mismatch' })
    }
    if (payload.emerg === true) {
      req.adminUserId = payload.sub
      req.adminEmail = payload.em
      req.adminEmergency = true
      return next()
    }
    const row = await authStore.getTrustedDeviceRow(payload.sub, payload.fp)
    if (!row || row.blocked) {
      return res.status(403).json({ ok: false, error: 'Device blocked or removed' })
    }
    if (row.force_otp_next) {
      return res.status(403).json({ ok: false, code: 'FORCE_OTP', error: 'Re-verification required' })
    }
    req.adminUserId = payload.sub
    req.adminEmail = payload.em
    req.adminEmergency = false
    return next()
  } catch (e) {
    return next(e)
  }
}

function sessionJwt(user, fpHash, opts = {}) {
  return signAdminJwt(
    {
      sub: user.id,
      em: user.email,
      fp: fpHash,
      emerg: opts.emergency === true,
    },
    { ttlSeconds: opts.ttlSeconds ?? 86400 },
  )
}

function pendingJwt(user, fpHash) {
  return signAdminJwt(
    {
      sub: user.id,
      em: user.email,
      fp: fpHash,
      typ: OTP_PENDING_TYP,
    },
    { ttlSeconds: 900 },
  )
}

adminAuthRouter.get('/status', (_req, res) => {
  res.json({
    ok: true,
    panelAuthRequired: isAdminPanelAuthRequired(),
  })
})

adminAuthRouter.post('/login', async (req, res) => {
  try {
    if (!isAdminPanelAuthRequired()) {
      return res.status(400).json({
        ok: false,
        error: 'Panel auth is disabled (set ADMIN_PANEL_AUTH_REQUIRED=true)',
      })
    }

    const ip = clientIp(req)
    const lockKey = `login:${ip}`
    const lu = lockedUntil(lockKey)
    if (lu) {
      return res.status(429).json({
        ok: false,
        error: 'Too many attempts',
        retry_after_seconds: Math.ceil((lu - Date.now()) / 1000),
      })
    }

    if (!pruneBucket(loginAttempts, lockKey, 15 * 60_000, 25)) {
      setLock(lockKey, 15 * 60_000)
      adminAuthAudit('login_failure', { reason: 'rate_ip', ip })
      return res.status(429).json({ ok: false, error: 'Too many login attempts' })
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()
    const deviceName = String(body.device_name ?? body.deviceName ?? 'Admin device').slice(0, 200)
    const browser = String(body.browser ?? req.headers['user-agent'] ?? '').slice(0, 400)

    if (!email || !password || !deviceFingerprint) {
      return res.status(400).json({ ok: false, error: 'email, password, and device_fingerprint required' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    const user = await authStore.findAdminUserByEmail(email)
    if (!user || !(await authStore.verifyAdminPassword(user, password))) {
      adminAuthAudit('login_failure', { email, ip, reason: 'bad_credentials' })
      return res.status(401).json({ ok: false, error: 'Invalid email or password' })
    }

    const existing = await authStore.getTrustedDeviceRow(user.id, fpHash)
    if (existing?.blocked === true) {
      adminAuthAudit('login_failure', { email, reason: 'device_blocked' })
      return res.status(403).json({ ok: false, error: 'This device is blocked' })
    }

    const trusted =
      existing &&
      existing.trusted === true &&
      existing.blocked !== true &&
      existing.force_otp_next !== true

    if (trusted) {
      await authStore.touchTrustedDeviceLastUsed(existing.id)
      const token = sessionJwt(user, fpHash)
      adminAuthAudit('login_success', { email, device_id: existing.id })
      return res.json({
        ok: true,
        step: 'authenticated',
        token,
        email: user.email,
        deviceId: existing.id,
      })
    }

    if (existing?.force_otp_next === true) {
      await authStore.invalidateActiveOtps(user.id, fpHash)
    }

    const otpPlain = authStore.generateOtp6()
    await authStore.insertLoginOtp({ userId: user.id, fpHash, codePlain: otpPlain })
    const emailed = await sendAdminOtpEmail({ to: user.email, otp: otpPlain })
    if (!emailed.ok && !emailed.skipped) {
      adminAuthAudit('otp_failed', { email, reason: 'email_send' })
      return res.status(503).json({ ok: false, error: 'Could not send OTP email (check Resend configuration)' })
    }

    const pendingToken = pendingJwt(user, fpHash)
    adminAuthAudit('otp_sent', { email, ip, resend_skipped: emailed.skipped === true })
    return res.json({
      ok: true,
      step: 'otp_required',
      pendingToken,
      email: user.email,
      message: emailed.skipped ? 'OTP generated (email not configured — check server logs / dev only)' : 'OTP sent to email',
      devOtpHint:
        process.env.ADMIN_OTP_DEBUG_RETURN === '1' && process.env.NODE_ENV !== 'production'
          ? otpPlain
          : undefined,
    })
  } catch (e) {
    console.error('[admin-auth login]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/verify-otp', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pendingToken = String(body.pending_token ?? body.pendingToken ?? '').trim()
    const code = String(body.code ?? body.otp ?? '').replace(/\D/g, '').slice(0, 6)
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()
    const deviceName = String(body.device_name ?? body.deviceName ?? 'Admin device').slice(0, 200)
    const browser = String(body.browser ?? req.headers['user-agent'] ?? '').slice(0, 400)
    const ip = clientIp(req)

    if (!pendingToken || code.length !== 6 || !deviceFingerprint) {
      return res.status(400).json({ ok: false, error: 'pending_token, 6-digit code, device_fingerprint required' })
    }

    const payload = verifyAdminJwt(pendingToken)
    if (!payload?.sub || payload.typ !== OTP_PENDING_TYP || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired pending session' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    if (fpHash !== payload.fp) {
      adminAuthAudit('otp_failed', { reason: 'fp_mismatch' })
      return res.status(401).json({ ok: false, error: 'Device mismatch' })
    }

    const failKey = `v:${payload.sub}:${fpHash}`
    const lu = lockedUntil(failKey)
    if (lu) {
      return res.status(429).json({
        ok: false,
        error: 'Too many failures — try later',
        retry_after_seconds: Math.ceil((lu - Date.now()) / 1000),
      })
    }

    const otpId = await authStore.verifyLoginOtpActive({
      userId: payload.sub,
      fpHash,
      codePlain: code,
    })

    if (!otpId) {
      const n = (otpVerifyFails.get(failKey) || 0) + 1
      otpVerifyFails.set(failKey, n)
      adminAuthAudit('otp_failed', { email: payload.em, reason: 'bad_code', count: n })
      const maxFail = Math.min(30, Math.max(3, Number(process.env.ADMIN_OTP_MAX_VERIFY_FAIL) || 8))
      if (n >= maxFail) {
        const lockMin = Math.min(120, Math.max(5, Number(process.env.ADMIN_OTP_LOCK_MINUTES) || 15))
        setLock(failKey, lockMin * 60_000)
      }
      return res.status(401).json({ ok: false, error: 'Invalid or expired code' })
    }

    otpVerifyFails.delete(failKey)
    await authStore.markLoginOtpUsed(otpId)

    const user = await authStore.findAdminUserByEmail(payload.em)
    if (!user || user.id !== payload.sub) {
      return res.status(400).json({ ok: false, error: 'User not found' })
    }

    await authStore.upsertTrustedDevice({
      userId: user.id,
      fpHash,
      deviceName,
      browser,
      ip,
    })

    const token = sessionJwt(user, fpHash)
    adminAuthAudit('otp_verified', { email: user.email })
    adminAuthAudit('trusted_device_added', { email: user.email, fp_hash: fpHash })
    return res.json({ ok: true, token, email: user.email })
  } catch (e) {
    console.error('[admin-auth verify-otp]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/resend-otp', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pendingToken = String(body.pending_token ?? body.pendingToken ?? '').trim()
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()

    if (!pendingToken || !deviceFingerprint) {
      return res.status(400).json({ ok: false, error: 'pending_token and device_fingerprint required' })
    }

    const payload = verifyAdminJwt(pendingToken)
    if (!payload?.sub || payload.typ !== OTP_PENDING_TYP || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid pending session' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    if (fpHash !== payload.fp) {
      return res.status(401).json({ ok: false, error: 'Device mismatch' })
    }

    const sendKey = `send:${payload.em}`
    const maxHour = Math.min(20, Math.max(1, Number(process.env.ADMIN_OTP_RESEND_PER_HOUR) || 5))
    if (!pruneBucket(otpSends, sendKey, 60 * 60_000, maxHour)) {
      adminAuthAudit('invalid_attempt', { action: 'otp_resend_exceeded', email: payload.em })
      return res.status(429).json({ ok: false, error: 'Too many OTP resend requests' })
    }

    await authStore.invalidateActiveOtps(payload.sub, fpHash)
    const otpPlain = authStore.generateOtp6()
    await authStore.insertLoginOtp({ userId: payload.sub, fpHash, codePlain: otpPlain })
    const emailed = await sendAdminOtpEmail({ to: payload.em, otp: otpPlain })

    adminAuthAudit('otp_sent', { email: payload.em, resend: true })
    return res.json({
      ok: true,
      message: emailed.skipped ? 'OTP regenerated (email skipped)' : 'OTP resent',
      devOtpHint:
        process.env.ADMIN_OTP_DEBUG_RETURN === '1' && process.env.NODE_ENV !== 'production'
          ? otpPlain
          : undefined,
    })
  } catch (e) {
    console.error('[admin-auth resend-otp]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/emergency-pin', async (req, res) => {
  try {
    if (!isAdminPanelAuthRequired()) {
      return res.status(400).json({ ok: false, error: 'Panel auth disabled' })
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const pin = String(body.pin ?? '').trim()
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()

    if (!email || !password || !pin || !deviceFingerprint) {
      return res.status(400).json({ ok: false, error: 'email, password, pin, device_fingerprint required' })
    }

    const user = await authStore.findAdminUserByEmail(email)
    if (!user || !(await authStore.verifyAdminPassword(user, password))) {
      adminAuthAudit('login_failure', { email, reason: 'emergency_bad_credentials' })
      return res.status(401).json({ ok: false, error: 'Invalid credentials' })
    }

    if (!(await billing.verifyManualSubscriptionGrantPin(pin))) {
      adminAuthAudit('login_failure', { email, reason: 'emergency_bad_pin' })
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    const ttl = Math.min(86400, Math.max(600, Number(process.env.ADMIN_EMERGENCY_SESSION_SECONDS) || 7200))
    const token = sessionJwt(user, fpHash, { emergency: true, ttlSeconds: ttl })
    adminAuthAudit('emergency_pin_access', { email })
    return res.json({ ok: true, token, email: user.email, emergency: true })
  } catch (e) {
    console.error('[admin-auth emergency]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.get('/me', attachAdminReq, async (req, res) => {
  try {
    const fpRaw = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    const fpHash = authStore.hashAdminDeviceFingerprint(fpRaw)
    const row = req.adminEmergency ? null : await authStore.getTrustedDeviceRow(req.adminUserId, fpHash)
    res.json({
      ok: true,
      email: req.adminEmail,
      emergency: req.adminEmergency === true,
      device: row
        ? {
            id: row.id,
            forceOtpNext: row.force_otp_next === true,
            blocked: row.blocked === true,
          }
        : null,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.get('/devices', attachAdminReq, async (req, res) => {
  try {
    const rows = await authStore.listTrustedDevicesForUser(req.adminUserId)
    const fpRaw = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    const currentHash = authStore.hashAdminDeviceFingerprint(fpRaw)
    const mapped = rows.map((r) => ({
      id: r.id,
      deviceFingerprintHash: r.device_fingerprint_hash,
      deviceName: r.device_name,
      browser: r.browser,
      ipAddress: r.ip_address,
      trusted: r.trusted === true,
      blocked: r.blocked === true,
      forceOtpNext: r.force_otp_next === true,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      lastUsedAt: r.last_used_at instanceof Date ? r.last_used_at.toISOString() : r.last_used_at,
      isCurrentDevice: r.device_fingerprint_hash === currentHash,
    }))
    res.json({ ok: true, devices: mapped })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/devices/:id/block', attachAdminReq, async (req, res) => {
  try {
    const ok = await authStore.setDeviceBlocked(req.params.id, req.adminUserId, true)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_blocked', { device_id: req.params.id, email: req.adminEmail })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/devices/:id/unblock', attachAdminReq, async (req, res) => {
  try {
    const ok = await authStore.setDeviceBlocked(req.params.id, req.adminUserId, false)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_unblocked', { device_id: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.delete('/devices/:id', attachAdminReq, async (req, res) => {
  try {
    const ok = await authStore.deleteTrustedDevice(req.params.id, req.adminUserId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_removed', { device_id: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/devices/:id/force-otp', attachAdminReq, async (req, res) => {
  try {
    const ok = await authStore.setDeviceForceOtp(req.params.id, req.adminUserId, true)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_force_otp', { device_id: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/logout', (_req, res) => {
  res.json({ ok: true })
})
