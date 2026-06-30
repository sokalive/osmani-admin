import { Router } from 'express'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import * as authStore from '../adminAuthStore.js'
import { adminAuthAudit } from '../lib/adminAuthAudit.js'
import { signAdminJwt, verifyAdminJwt } from '../lib/adminJwt.js'
import { sendAdminOtpEmail, sendAdminSecurityGateOtpEmail } from '../lib/resendOtpMail.js'
import {
  OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE,
  OTP_PURPOSE_ADMIN_SECURITY_GATE,
  adminAlertEmail,
  createOtpChallenge,
  issueOtpForChallenge,
  logOtpSecurityEvent,
  verifyOtpForChallenge,
  CHALLENGE_TTL_MINUTES,
} from '../lib/adminOtpChallengeStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { isAdminPanelAuthRequired } from '../middleware/adminPanelAuthGate.js'
import {
  adminSecurityPinFromBody,
  verifyAdminSecurityPin,
} from '../lib/adminSecurityPin.js'

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

function adminSecurityMeta(req) {
  return {
    adminUserId: String(req.adminUserId ?? ''),
    adminEmail: String(req.adminEmail ?? ''),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
    deviceLabel: String(req.headers['x-admin-device-fingerprint'] ?? '').slice(0, 64),
  }
}

function maskAlertEmail(email) {
  const e = String(email ?? '')
  return e.replace(/^(.{2}).*(@.*)$/, '$1***$2')
}

function securityPageGateJwt(userId, email, challengeId) {
  return signAdminJwt(
    {
      sub: userId,
      em: email,
      typ: 'admin_security_gate',
      ch: challengeId,
    },
    { ttlSeconds: CHALLENGE_TTL_MINUTES * 60 },
  )
}

function requireAdminSecurityPageGate(req, res, next) {
  if (req.adminEmergency === true) return next()
  const gate = String(req.headers['x-admin-security-gate'] ?? '').trim()
  const payload = verifyAdminJwt(gate)
  if (
    !payload ||
    payload.typ !== 'admin_security_gate' ||
    String(payload.sub) !== String(req.adminUserId)
  ) {
    return res.status(403).json({
      ok: false,
      code: 'SECURITY_GATE_REQUIRED',
      error: 'Admin Security email OTP required',
    })
  }
  req.adminSecurityGate = payload
  return next()
}

function requireAdminSecurityPin(req, res, next) {
  const pin = adminSecurityPinFromBody(req)
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'security_pin required' })
  }
  if (!verifyAdminSecurityPin(pin)) {
    adminAuthAudit('security_pin_denied', { email: req.adminEmail, path: req.path })
    return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
  }
  next()
}

function currentSessionFingerprintHash(req) {
  const raw = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
  return authStore.hashAdminDeviceFingerprint(raw)
}

function confirmCurrentDeviceOk(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  return body.confirm_current_device === true || body.confirmCurrentDevice === true
}

/** Block / delete / force-OTP on the same trusted device as this session needs explicit confirmation. */
function sendCurrentDeviceConfirm(res) {
  return res.status(409).json({
    ok: false,
    code: 'CONFIRM_CURRENT_DEVICE',
    error: 'Hii ni kifaa unachokitumia sasa. Thibitisha kuendelea.',
  })
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

/** Extend an active admin session (same device fingerprint). */
adminAuthRouter.post('/refresh', attachAdminReq, async (req, res) => {
  try {
    const fpHash = currentSessionFingerprintHash(req)
    const user = await authStore.findAdminUserByEmail(req.adminEmail)
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid session' })
    }
    if (!req.adminEmergency) {
      const row = await authStore.getTrustedDeviceRow(req.adminUserId, fpHash)
      if (row?.id) await authStore.touchTrustedDeviceLastUsed(row.id)
    }
    const token = sessionJwt(user, fpHash, { emergency: req.adminEmergency === true })
    adminAuthAudit('session_refresh', { email: req.adminEmail })
    res.json({ ok: true, token, email: user.email })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/verify-security-pin', attachAdminReq, (req, res) => {
  const pin = adminSecurityPinFromBody(req)
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'security_pin required' })
  }
  if (!verifyAdminSecurityPin(pin)) {
    adminAuthAudit('security_pin_denied', { email: req.adminEmail, gate: 'admin_security_page' })
    return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
  }
  adminAuthAudit('security_pin_gate_ok', { email: req.adminEmail })
  res.json({ ok: true })
})

/** Admin Security page: PIN ok → email OTP challenge (does not unlock page alone). */
adminAuthRouter.post('/admin-security/verify-pin', attachAdminReq, async (req, res) => {
  const pool = getPool()
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      adminAuthAudit('security_pin_denied', { email: req.adminEmail, gate: 'admin_security_otp' })
      await logOtpSecurityEvent(pool, {
        actor: req.adminEmail,
        eventType: 'Admin Security PIN denied',
        status: 'failed',
        detail: 'Invalid PIN before OTP',
        metadata: { ip: clientIp(req), purpose: OTP_PURPOSE_ADMIN_SECURITY_GATE },
      })
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }

    const meta = adminSecurityMeta(req)
    const challenge = await createOtpChallenge(OTP_PURPOSE_ADMIN_SECURITY_GATE, meta)
    const alertTo = adminAlertEmail()
    if (!alertTo) {
      return res.status(503).json({ ok: false, error: 'ADMIN_ALERT_EMAIL is not configured' })
    }

    const issued = await issueOtpForChallenge(challenge.challengeToken, OTP_PURPOSE_ADMIN_SECURITY_GATE)
    const mailed = await sendAdminSecurityGateOtpEmail({ to: alertTo, otp: issued.otp })
    if (!mailed.ok) {
      return res.status(503).json({ ok: false, error: 'Could not send OTP email (check Resend configuration)' })
    }

    await logOtpSecurityEvent(pool, {
      actor: meta.adminEmail,
      eventType: 'Admin Security OTP sent',
      status: 'completed',
      detail: `OTP emailed to ${alertTo}`,
      metadata: {
        ip: meta.ip,
        purpose: OTP_PURPOSE_ADMIN_SECURITY_GATE,
        challenge_id: challenge.challengeId,
      },
    })
    adminAuthAudit('admin_security_otp_sent', { email: req.adminEmail })

    res.json({
      ok: true,
      requiresOtp: true,
      challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt,
      maskedEmail: maskAlertEmail(alertTo),
      resendAvailableAt: issued.resendAvailableAt,
    })
  } catch (e) {
    console.error('[admin-security] verify-pin', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/admin-security/resend-otp', attachAdminReq, async (req, res) => {
  const pool = getPool()
  try {
    const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
    if (!challengeToken) return res.status(400).json({ ok: false, error: 'challengeToken required' })
    const alertTo = adminAlertEmail()
    if (!alertTo) return res.status(503).json({ ok: false, error: 'ADMIN_ALERT_EMAIL not configured' })

    const issued = await issueOtpForChallenge(challengeToken, OTP_PURPOSE_ADMIN_SECURITY_GATE)
    const mailed = await sendAdminSecurityGateOtpEmail({ to: alertTo, otp: issued.otp })
    if (!mailed.ok) {
      return res.status(503).json({ ok: false, error: 'Could not send OTP email' })
    }

    await logOtpSecurityEvent(pool, {
      actor: req.adminEmail,
      eventType: 'Admin Security OTP resent',
      status: 'completed',
      detail: `OTP resent to ${alertTo}`,
      metadata: { ip: clientIp(req), challenge_id: issued.challengeId, resend: true },
    })

    res.json({
      ok: true,
      maskedEmail: maskAlertEmail(alertTo),
      resendAvailableAt: issued.resendAvailableAt,
    })
  } catch (e) {
    console.error('[admin-security] resend-otp', e)
    const status = String(e.message || '').includes('wait') ? 429 : 400
    await logOtpSecurityEvent(pool, {
      actor: req.adminEmail,
      eventType: 'Admin Security OTP resend failed',
      status: 'failed',
      detail: String(e.message || e),
      metadata: { ip: clientIp(req) },
    }).catch(() => {})
    res.status(status).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post('/admin-security/verify-otp', attachAdminReq, async (req, res) => {
  const pool = getPool()
  try {
    const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
    const otp = String(req.body?.otp ?? req.body?.code ?? '').trim()
    if (!challengeToken || !otp) {
      return res.status(400).json({ ok: false, error: 'challengeToken and otp required' })
    }

    const verified = await verifyOtpForChallenge(
      challengeToken,
      otp,
      OTP_PURPOSE_ADMIN_SECURITY_GATE,
    )
    const gateToken = securityPageGateJwt(req.adminUserId, req.adminEmail, verified.challengeId)

    await logOtpSecurityEvent(pool, {
      actor: req.adminEmail,
      eventType: 'Admin Security OTP verified',
      status: 'completed',
      detail: 'Admin Security page unlocked',
      metadata: {
        ip: clientIp(req),
        challenge_id: verified.challengeId,
        otp_verified: true,
      },
    })
    adminAuthAudit('admin_security_gate_ok', { email: req.adminEmail })

    res.json({ ok: true, gateToken, expiresInSeconds: CHALLENGE_TTL_MINUTES * 60 })
  } catch (e) {
    console.error('[admin-security] verify-otp', e)
    const msg = String(e.message || e)
    await logOtpSecurityEvent(pool, {
      actor: req.adminEmail,
      eventType: 'Admin Security OTP verify failed',
      status: 'failed',
      detail: msg,
      metadata: { ip: clientIp(req), otp_verified: false },
    }).catch(() => {})
    const status = msg.includes('expired') || msg.includes('Invalid') ? 403 : 400
    res.status(status).json({ ok: false, error: msg })
  }
})

const DESTRUCTIVE_DELETE_DEVICES = 'delete_devices'
const DESTRUCTIVE_DELETE_ALL_LOGS = 'delete_all_security_logs'

function emitSecurityLogsSync(payload) {
  liveSyncBus.publish('security_logs_changed', {
    topics: ['config'],
    ...payload,
    synced_at: new Date().toISOString(),
  })
  liveSyncBus.publish('security_alerts_changed', {
    topics: ['config'],
    ...payload,
    synced_at: new Date().toISOString(),
  })
}

function parseDestructiveAction(body) {
  const b = body && typeof body === 'object' ? body : {}
  const action = String(b.action ?? '').trim()
  if (action === DESTRUCTIVE_DELETE_DEVICES) {
    const ids = Array.isArray(b.deviceIds ?? b.device_ids)
      ? (b.deviceIds ?? b.device_ids).map((x) => String(x).trim()).filter(Boolean)
      : []
    if (ids.length === 0) throw new Error('deviceIds required')
    return { type: DESTRUCTIVE_DELETE_DEVICES, payload: { deviceIds: ids } }
  }
  if (action === DESTRUCTIVE_DELETE_ALL_LOGS) {
    return { type: DESTRUCTIVE_DELETE_ALL_LOGS, payload: {} }
  }
  throw new Error('Invalid destructive action')
}

adminAuthRouter.post(
  '/admin-security/destructive/start',
  attachAdminReq,
  requireAdminSecurityPageGate,
  async (req, res) => {
    const pool = getPool()
    try {
      const pin = adminSecurityPinFromBody(req)
      if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
      if (!verifyAdminSecurityPin(pin)) {
        adminAuthAudit('security_pin_denied', { email: req.adminEmail, gate: 'destructive' })
        return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
      }

      const action = parseDestructiveAction(req.body)
      const meta = adminSecurityMeta(req)
      const challenge = await createOtpChallenge(
        OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE,
        meta,
        action,
      )
      const alertTo = adminAlertEmail()
      if (!alertTo) {
        return res.status(503).json({ ok: false, error: 'ADMIN_ALERT_EMAIL is not configured' })
      }

      const issued = await issueOtpForChallenge(
        challenge.challengeToken,
        OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE,
      )
      const mailed = await sendAdminSecurityGateOtpEmail({ to: alertTo, otp: issued.otp })
      if (!mailed.ok) {
        return res.status(503).json({ ok: false, error: 'Could not send OTP email (check Resend configuration)' })
      }

      await logOtpSecurityEvent(pool, {
        actor: meta.adminEmail,
        eventType: 'Admin Security destructive OTP sent',
        status: 'completed',
        detail: `Action: ${action.type}`,
        metadata: { ip: meta.ip, action: action.type, challenge_id: challenge.challengeId },
      })

      res.json({
        ok: true,
        challengeToken: challenge.challengeToken,
        maskedEmail: maskAlertEmail(alertTo),
        resendAvailableAt: issued.resendAvailableAt,
        action: action.type,
      })
    } catch (e) {
      console.error('[admin-security] destructive/start', e)
      res.status(400).json({ ok: false, error: String(e.message || e) })
    }
  },
)

adminAuthRouter.post(
  '/admin-security/destructive/resend-otp',
  attachAdminReq,
  requireAdminSecurityPageGate,
  async (req, res) => {
    const pool = getPool()
    try {
      const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
      if (!challengeToken) return res.status(400).json({ ok: false, error: 'challengeToken required' })
      const alertTo = adminAlertEmail()
      if (!alertTo) return res.status(503).json({ ok: false, error: 'ADMIN_ALERT_EMAIL not configured' })

      const issued = await issueOtpForChallenge(
        challengeToken,
        OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE,
      )
      const mailed = await sendAdminSecurityGateOtpEmail({ to: alertTo, otp: issued.otp })
      if (!mailed.ok) {
        return res.status(503).json({ ok: false, error: 'Could not send OTP email' })
      }

      await logOtpSecurityEvent(pool, {
        actor: req.adminEmail,
        eventType: 'Admin Security destructive OTP resent',
        status: 'completed',
        detail: `OTP resent to ${alertTo}`,
        metadata: { ip: clientIp(req), challenge_id: issued.challengeId, resend: true },
      })

      res.json({
        ok: true,
        maskedEmail: maskAlertEmail(alertTo),
        resendAvailableAt: issued.resendAvailableAt,
      })
    } catch (e) {
      const status = String(e.message || '').includes('wait') ? 429 : 400
      res.status(status).json({ ok: false, error: String(e.message || e) })
    }
  },
)

adminAuthRouter.post(
  '/admin-security/destructive/execute',
  attachAdminReq,
  requireAdminSecurityPageGate,
  async (req, res) => {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    try {
      const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
      const otp = String(req.body?.otp ?? req.body?.code ?? '').trim()
      const confirmCurrent =
        req.body?.confirm_current_device === true || req.body?.confirmCurrentDevice === true
      if (!challengeToken || !otp) {
        return res.status(400).json({ ok: false, error: 'challengeToken and otp required' })
      }

      const verified = await verifyOtpForChallenge(
        challengeToken,
        otp,
        OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE,
      )
      const actionType = verified.actionType
      const payload = verified.actionPayload || {}

      if (actionType === DESTRUCTIVE_DELETE_DEVICES) {
        const deviceIds = Array.isArray(payload.deviceIds)
          ? payload.deviceIds.map((x) => String(x).trim()).filter(Boolean)
          : []
        if (deviceIds.length === 0) {
          return res.status(400).json({ ok: false, error: 'No devices in challenge' })
        }
        const curHash = currentSessionFingerprintHash(req)
        for (const id of deviceIds) {
          const row = await authStore.getTrustedDeviceRowById(id, req.adminUserId)
          if (row?.device_fingerprint_hash === curHash && !confirmCurrent) {
            return sendCurrentDeviceConfirm(res)
          }
        }
        const deleted = await authStore.deleteTrustedDevicesBulk(deviceIds, req.adminUserId)
        adminAuthAudit('devices_bulk_removed', {
          email: req.adminEmail,
          count: deleted,
          device_ids: deviceIds,
        })
        await logOtpSecurityEvent(pool, {
          actor: req.adminEmail,
          eventType: 'Admin Security bulk device delete',
          status: 'completed',
          detail: `Removed ${deleted} trusted device(s)`,
          metadata: { ip: clientIp(req), deleted, device_ids: deviceIds },
        })
        return res.json({ ok: true, deleted, action: actionType })
      }

      if (actionType === DESTRUCTIVE_DELETE_ALL_LOGS) {
        const out = await pool.query(`DELETE FROM security_events`)
        const deleted = Number(out.rowCount) || 0
        emitSecurityLogsSync({ action: 'bulk_delete', deleted, mode: 'all', source: 'admin_security' })
        await logOtpSecurityEvent(pool, {
          actor: req.adminEmail,
          eventType: 'Admin Security cleared all security logs',
          status: 'completed',
          detail: `Deleted ${deleted} security log row(s)`,
          metadata: { ip: clientIp(req), deleted },
        })
        adminAuthAudit('security_logs_cleared', { email: req.adminEmail, deleted })
        return res.json({ ok: true, deleted, action: actionType })
      }

      return res.status(400).json({ ok: false, error: 'Unknown destructive action' })
    } catch (e) {
      const msg = String(e.message || e)
      await logOtpSecurityEvent(pool, {
        actor: req.adminEmail,
        eventType: 'Admin Security destructive action failed',
        status: 'failed',
        detail: msg,
        metadata: { ip: clientIp(req) },
      }).catch(() => {})
      const status = msg.includes('expired') || msg.includes('Invalid') ? 403 : 400
      res.status(status).json({ ok: false, error: msg })
    }
  },
)

adminAuthRouter.get('/devices', attachAdminReq, requireAdminSecurityPageGate, async (req, res) => {
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

adminAuthRouter.post(
  '/devices/:id/block',
  attachAdminReq,
  requireAdminSecurityPageGate,
  requireAdminSecurityPin,
  async (req, res) => {
  try {
    const row = await authStore.getTrustedDeviceRowById(req.params.id, req.adminUserId)
    if (!row) return res.status(404).json({ ok: false, error: 'Device not found' })
    const curHash = currentSessionFingerprintHash(req)
    if (row.device_fingerprint_hash === curHash && !confirmCurrentDeviceOk(req)) {
      return sendCurrentDeviceConfirm(res)
    }
    const ok = await authStore.setDeviceBlocked(req.params.id, req.adminUserId, true)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_blocked', { device_id: req.params.id, email: req.adminEmail })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post(
  '/devices/:id/unblock',
  attachAdminReq,
  requireAdminSecurityPageGate,
  requireAdminSecurityPin,
  async (req, res) => {
  try {
    const ok = await authStore.setDeviceBlocked(req.params.id, req.adminUserId, false)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_unblocked', { device_id: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.delete(
  '/devices/:id',
  attachAdminReq,
  requireAdminSecurityPageGate,
  requireAdminSecurityPin,
  async (req, res) => {
  try {
    const row = await authStore.getTrustedDeviceRowById(req.params.id, req.adminUserId)
    if (!row) return res.status(404).json({ ok: false, error: 'Device not found' })
    const curHash = currentSessionFingerprintHash(req)
    if (row.device_fingerprint_hash === curHash && !confirmCurrentDeviceOk(req)) {
      return sendCurrentDeviceConfirm(res)
    }
    const ok = await authStore.deleteTrustedDevice(req.params.id, req.adminUserId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
    adminAuthAudit('device_removed', { device_id: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

adminAuthRouter.post(
  '/devices/:id/force-otp',
  attachAdminReq,
  requireAdminSecurityPageGate,
  requireAdminSecurityPin,
  async (req, res) => {
  try {
    const row = await authStore.getTrustedDeviceRowById(req.params.id, req.adminUserId)
    if (!row) return res.status(404).json({ ok: false, error: 'Device not found' })
    const curHash = currentSessionFingerprintHash(req)
    if (row.device_fingerprint_hash === curHash && !confirmCurrentDeviceOk(req)) {
      return sendCurrentDeviceConfirm(res)
    }
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
