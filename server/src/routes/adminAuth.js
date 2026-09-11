import { Router } from 'express'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import * as authStore from '../adminAuthStore.js'
import { adminAuthAudit } from '../lib/adminAuthAudit.js'
import { signAdminJwt, verifyAdminJwt } from '../lib/adminJwt.js'
import {
  sendAdminOtpEmail,
  sendAdminSecurityGateOtpEmail,
  sendNewAdminDeviceAlertEmail,
} from '../lib/resendOtpMail.js'
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
import {
  isAdminPanelAuthRequired,
  requireAdminPanelAccess,
} from '../middleware/adminPanelAuthGate.js'
import {
  adminSecurityPinFromBody,
  verifyAdminSecurityPin,
} from '../lib/adminSecurityPin.js'
import {
  clearAdminAuthCookies,
  clearAdminSessionCookie,
  readAdminDeviceCredential,
  readAdminSessionToken,
  setAdminAuthCookies,
} from '../lib/adminAuthCookies.js'
import {
  allowedAdminLoginEmail,
  verifyAdminLoginCredential,
} from '../lib/adminLoginPin.js'
import { defaultDeviceName, parseAdminUserAgent } from '../lib/adminUaParse.js'
import { lookupIpGeo } from '../lib/ipGeoLookup.js'
import { hashAdminDeviceCredential } from '../lib/adminDeviceCredential.js'

export const adminAuthRouter = Router()

const OTP_PENDING_TYP = 'otp_pending'

/**
 * Session JWT lifetime. Default matches fixed trusted-device window (14 days = 336 hours).
 * Sessions may be shorter; GET /session re-issues while trusted_expires_at is still valid.
 */
const SESSION_TTL_SECONDS = Math.min(
  90 * 86400,
  Math.max(
    3600,
    Number(process.env.ADMIN_SESSION_TTL_SECONDS) || authStore.TRUSTED_DEVICE_TTL_SECONDS,
  ),
)

function sessionTtlSecondsForDevice(deviceRow, { emergency = false } = {}) {
  if (emergency) {
    return Math.min(86400, Math.max(600, Number(process.env.ADMIN_EMERGENCY_SESSION_SECONDS) || 7200))
  }
  const remaining = authStore.trustedDeviceRemainingSeconds(deviceRow)
  if (remaining > 0) return Math.min(SESSION_TTL_SECONDS, remaining)
  return SESSION_TTL_SECONDS
}

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

function isoDate(v) {
  if (!v) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

/**
 * Create jti, sign JWT (sub/em/fp/did/sv/jti/emerg), insert session row, set HttpOnly cookies.
 */
async function issueSession(res, req, {
  user,
  fpHash,
  deviceRow = null,
  emergency = false,
  deviceCredentialPlain = null,
  ttlSeconds = null,
} = {}) {
  const jti = authStore.newSessionJti()
  const ttl = Math.max(
    60,
    Number(ttlSeconds) || sessionTtlSecondsForDevice(deviceRow, { emergency }),
  )
  const token = signAdminJwt(
    {
      sub: user.id,
      em: user.email,
      fp: fpHash,
      did: deviceRow?.id || undefined,
      sv: deviceRow != null ? Number(deviceRow.session_version || 1) : undefined,
      jti,
      emerg: emergency === true,
    },
    { ttlSeconds: ttl },
  )

  await authStore.createAdminSession({
    userId: user.id,
    deviceId: deviceRow?.id || null,
    jti,
    expiresAt: new Date(Date.now() + ttl * 1000),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? ''),
  })

  setAdminAuthCookies(res, req, {
    sessionToken: token,
    maxAgeSec: ttl,
    ...(deviceCredentialPlain ? { deviceCredential: deviceCredentialPlain } : {}),
  })

  return { token, jti }
}

async function attachAdminReq(req, res, next) {
  try {
    if (!isAdminPanelAuthRequired()) {
      return res.status(503).json({ ok: false, error: 'ADMIN_PANEL_AUTH_REQUIRED is not enabled on the server' })
    }
    const token = readAdminSessionToken(req)
    const payload = token ? verifyAdminJwt(token) : null
    if (!payload?.sub || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid session', code: 'INVALID_SESSION' })
    }
    if (payload.typ === OTP_PENDING_TYP || payload.typ === 'admin_security_gate') {
      return res.status(401).json({ ok: false, error: 'Invalid session type', code: 'INVALID_SESSION' })
    }

    const rawFp = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    if (!rawFp || authStore.hashAdminDeviceFingerprint(rawFp) !== payload.fp) {
      return res.status(401).json({ ok: false, error: 'Device mismatch', code: 'DEVICE_MISMATCH' })
    }

    if (payload.jti) {
      const sess = await authStore.getActiveSessionByJti(payload.jti)
      if (!sess) {
        return res.status(401).json({
          ok: false,
          error: 'Session revoked or expired',
          code: 'SESSION_REVOKED',
        })
      }
      void authStore.touchSession(payload.jti)
    }

    if (payload.emerg === true) {
      req.adminUserId = payload.sub
      req.adminEmail = payload.em
      req.adminEmergency = true
      req.adminJti = payload.jti
      return next()
    }

    const row = await authStore.getTrustedDeviceRow(payload.sub, payload.fp)
    if (!row) {
      return res.status(403).json({
        ok: false,
        error: 'Trusted device removed — sign in again',
        code: 'DEVICE_REVOKED',
      })
    }
    if (row.blocked === true || row.status === 'BLOCKED') {
      return res.status(403).json({
        ok: false,
        error: 'This device is blocked',
        code: 'DEVICE_BLOCKED',
      })
    }
    if (row.revoked_at || row.status === 'REVOKED') {
      return res.status(403).json({
        ok: false,
        error: 'This device was revoked',
        code: 'DEVICE_REVOKED',
      })
    }
    if (row.force_otp_next === true) {
      return res.status(403).json({ ok: false, code: 'FORCE_OTP', error: 'Re-verification required' })
    }
    if (authStore.isTrustedDeviceExpired(row)) {
      return res.status(401).json({
        ok: false,
        error: 'Trusted device expired — sign in again',
        code: 'TRUST_EXPIRED',
      })
    }
    if (payload.sv != null && Number(payload.sv) !== Number(row.session_version || 1)) {
      return res.status(401).json({
        ok: false,
        error: 'Session invalidated',
        code: 'SESSION_REVOKED',
      })
    }

    void authStore.touchTrustedDeviceLastUsed(row.id)
    req.adminUserId = payload.sub
    req.adminEmail = payload.em
    req.adminEmergency = false
    req.adminDeviceId = row.id
    req.adminJti = payload.jti
    return next()
  } catch (e) {
    return next(e)
  }
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

function mapDeviceRow(r, currentHash) {
  const createdAt = isoDate(r.created_at)
  const lastUsedAt = isoDate(r.last_used_at)
  return {
    id: r.id,
    deviceFingerprintHash: r.device_fingerprint_hash,
    deviceName: r.device_name,
    browser: r.browser,
    ipAddress: r.ip_address,
    deviceType: r.device_type || null,
    osName: r.os_name || null,
    country: r.country || null,
    region: r.region || null,
    city: r.city || null,
    isp: r.isp || null,
    trusted: r.trusted === true,
    blocked: r.blocked === true,
    forceOtpNext: r.force_otp_next === true,
    status: r.derived_status || authStore.deriveStatus(r),
    createdAt,
    lastUsedAt,
    lastLoginAt: isoDate(r.last_login_at),
    trustedExpiresAt: isoDate(r.trusted_expires_at),
    firstSeen: createdAt,
    lastActive: lastUsedAt,
    isCurrentDevice: r.device_fingerprint_hash === currentHash,
  }
}

adminAuthRouter.get('/status', (_req, res) => {
  res.json({
    ok: true,
    panelAuthRequired: isAdminPanelAuthRequired(),
  })
})

/**
 * Restore session from HttpOnly session cookie, or re-issue from trusted device credential
 * (login once per trusted device).
 */
adminAuthRouter.get('/session', async (req, res) => {
  try {
    if (!isAdminPanelAuthRequired()) {
      return res.json({ ok: true, authenticated: false, panelAuthRequired: false })
    }

    const rawFp = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    const fpHash = rawFp ? authStore.hashAdminDeviceFingerprint(rawFp) : ''

    const sessionToken = readAdminSessionToken(req)
    if (sessionToken) {
      const payload = verifyAdminJwt(sessionToken)
      if (
        payload?.sub &&
        payload.fp &&
        payload.typ !== OTP_PENDING_TYP &&
        payload.typ !== 'admin_security_gate'
      ) {
        if (fpHash && fpHash !== payload.fp) {
          return res.status(401).json({ ok: false, authenticated: false, error: 'Device mismatch' })
        }
        if (payload.jti) {
          const sess = await authStore.getActiveSessionByJti(payload.jti)
          if (!sess) {
            /* fall through to device credential */
          } else if (payload.emerg === true) {
            void authStore.touchSession(payload.jti)
            return res.json({
              ok: true,
              authenticated: true,
              email: payload.em,
              emergency: true,
              token: sessionToken,
            })
          } else {
            const row = await authStore.getTrustedDeviceRow(payload.sub, payload.fp)
            if (
              row &&
              authStore.isTrustedDeviceActive(row) &&
              (payload.sv == null || Number(payload.sv) === Number(row.session_version || 1))
            ) {
              void authStore.touchSession(payload.jti)
              void authStore.touchTrustedDeviceLastUsed(row.id)
              return res.json({
                ok: true,
                authenticated: true,
                email: payload.em,
                emergency: false,
                deviceId: row.id,
                trustedExpiresAt: isoDate(row.trusted_expires_at),
                token: sessionToken,
              })
            }
          }
        } else if (payload.emerg === true) {
          return res.json({
            ok: true,
            authenticated: true,
            email: payload.em,
            emergency: true,
            token: sessionToken,
          })
        }
      }
    }

    const deviceCred = readAdminDeviceCredential(req)
    if (!deviceCred || !rawFp) {
      return res.json({ ok: true, authenticated: false })
    }

    const credHash = hashAdminDeviceCredential(deviceCred)
    const device = await authStore.getTrustedDeviceByCredentialHash(credHash)
    if (!device) {
      return res.json({ ok: true, authenticated: false })
    }
    if (device.blocked === true || device.status === 'BLOCKED') {
      return res.status(403).json({
        ok: false,
        authenticated: false,
        code: 'DEVICE_BLOCKED',
        error: 'This device is blocked',
      })
    }
    if (device.revoked_at || device.status === 'REVOKED') {
      return res.json({ ok: true, authenticated: false, code: 'DEVICE_REVOKED' })
    }
    if (device.force_otp_next === true || device.trusted !== true) {
      return res.json({ ok: true, authenticated: false, code: 'FORCE_OTP' })
    }
    if (authStore.isTrustedDeviceExpired(device)) {
      return res.json({
        ok: true,
        authenticated: false,
        code: 'TRUST_EXPIRED',
        error: 'Trusted device expired — sign in again',
      })
    }
    if (device.device_fingerprint_hash !== fpHash) {
      return res.status(401).json({ ok: false, authenticated: false, error: 'Device mismatch' })
    }

    const user = await authStore.findAdminUserById(device.admin_user_id)
    if (!user) {
      return res.json({ ok: true, authenticated: false })
    }

    await authStore.touchTrustedDeviceLastUsed(device.id)
    const { token } = await issueSession(res, req, {
      user,
      fpHash,
      deviceRow: device,
    })
    adminAuthAudit('session_restore_device_cred', { email: user.email, device_id: device.id })
    return res.json({
      ok: true,
      authenticated: true,
      email: user.email,
      emergency: false,
      deviceId: device.id,
      trustedExpiresAt: isoDate(device.trusted_expires_at),
      token,
    })
  } catch (e) {
    console.error('[admin-auth session]', e)
    res.status(500).json({ ok: false, authenticated: false, error: String(e.message || e) })
  }
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
    const pinOrPassword = String(body.pin ?? body.password ?? '')
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()
    const uaRaw = String(body.browser ?? req.headers['user-agent'] ?? '')
    const ua = parseAdminUserAgent(uaRaw)
    const deviceName = String(
      body.device_name ?? body.deviceName ?? defaultDeviceName(ua),
    ).slice(0, 200)

    if (!email || !pinOrPassword || !deviceFingerprint) {
      return res.status(400).json({ ok: false, error: 'email, pin (or password), and device_fingerprint required' })
    }

    if (!allowedAdminLoginEmail(email)) {
      adminAuthAudit('login_failure', { email, ip, reason: 'email_not_allowed' })
      return res.status(401).json({ ok: false, error: 'Invalid email or PIN' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    const user = await authStore.findAdminUserByEmail(email)
    if (!user || !(await verifyAdminLoginCredential(user, pinOrPassword))) {
      adminAuthAudit('login_failure', { email, ip, reason: 'bad_credentials' })
      return res.status(401).json({ ok: false, error: 'Invalid email or PIN' })
    }

    const existing = await authStore.getTrustedDeviceRow(user.id, fpHash)
    if (existing?.blocked === true || existing?.status === 'BLOCKED') {
      adminAuthAudit('login_failure', { email, reason: 'device_blocked' })
      await authStore.recordSecurityEvent({
        adminUserId: user.id,
        eventType: 'login_blocked_device',
        result: 'denied',
        deviceId: existing.id,
        ip,
        userAgent: ua.userAgent,
      })
      return res.status(403).json({
        ok: false,
        code: 'DEVICE_BLOCKED',
        error: 'This device is blocked',
      })
    }

    const trusted = authStore.isTrustedDeviceActive(existing)

    if (trusted) {
      await authStore.touchTrustedDeviceLastUsed(existing.id)
      const { token } = await issueSession(res, req, {
        user,
        fpHash,
        deviceRow: existing,
      })
      adminAuthAudit('login_success', { email, device_id: existing.id })
      await authStore.recordSecurityEvent({
        adminUserId: user.id,
        eventType: 'login_trusted_device',
        result: 'ok',
        deviceId: existing.id,
        ip,
        userAgent: ua.userAgent,
      })
      return res.json({
        ok: true,
        step: 'authenticated',
        token,
        email: user.email,
        deviceId: existing.id,
        trustedExpiresAt: isoDate(existing.trusted_expires_at),
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
    await authStore.recordSecurityEvent({
      adminUserId: user.id,
      eventType: 'login_otp_sent',
      result: 'ok',
      deviceId: existing?.id || null,
      ip,
      userAgent: ua.userAgent,
      metadata: { device_name: deviceName },
    })
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
    const uaRaw = String(body.browser ?? req.headers['user-agent'] ?? '')
    const ua = parseAdminUserAgent(uaRaw)
    const deviceName = String(
      body.device_name ?? body.deviceName ?? defaultDeviceName(ua),
    ).slice(0, 200)
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

    const geo = await lookupIpGeo(ip)
    const locationParts = []
    if (geo.ok) {
      if (geo.city) locationParts.push(geo.city)
      if (geo.region) locationParts.push(geo.region)
      if (geo.country) locationParts.push(geo.country)
      else if (geo.countryCode) locationParts.push(geo.countryCode)
    }
    const location = locationParts.join(', ') || 'Unknown'

    const { row, deviceCredentialPlain, isNewDevice } = await authStore.upsertTrustedDevice({
      userId: user.id,
      fpHash,
      deviceName,
      browser: ua.browser,
      ip,
      deviceType: ua.deviceType,
      osName: ua.osName,
      userAgent: ua.userAgent,
      country: geo.ok ? geo.country || geo.countryCode : '',
      region: geo.ok ? geo.region : '',
      city: geo.ok ? geo.city : '',
      isp: geo.ok ? geo.isp : '',
      rotateCredential: true,
    })

    const { token } = await issueSession(res, req, {
      user,
      fpHash,
      deviceRow: row,
      deviceCredentialPlain,
    })

    adminAuthAudit('otp_verified', { email: user.email })
    adminAuthAudit('trusted_device_added', { email: user.email, fp_hash: fpHash, new: isNewDevice })
    await authStore.recordSecurityEvent({
      adminUserId: user.id,
      eventType: isNewDevice ? 'new_trusted_device' : 'trusted_device_reverified',
      result: 'ok',
      deviceId: row?.id || null,
      ip,
      userAgent: ua.userAgent,
      metadata: {
        device_name: deviceName,
        os_name: ua.osName,
        browser: ua.browser,
        location,
      },
    })

    const alertTo = adminAlertEmail() || user.email
    if (isNewDevice && alertTo) {
      void sendNewAdminDeviceAlertEmail({
        to: alertTo,
        deviceName,
        osName: ua.osName,
        browser: ua.browser,
        ip,
        location,
        time: new Date().toISOString(),
      }).catch((err) => console.warn('[admin-auth] new device alert failed', err?.message || err))
    }

    return res.json({
      ok: true,
      token,
      email: user.email,
      deviceId: row?.id,
      isNewDevice: isNewDevice === true,
      trustedExpiresAt: isoDate(row?.trusted_expires_at),
      /** Mobile / non-cookie clients should store this as X-Admin-Device-Credential. */
      deviceCredential: deviceCredentialPlain || undefined,
    })
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
    const deviceFingerprint = String(body.device_fingerprint ?? body.deviceFingerprint ?? '').trim()
    // Legacy UI: password=login + pin=emergency. Also accept login_pin / emergency_pin.
    const credential = String(body.password ?? body.login_pin ?? body.loginPin ?? '').trim()
    const unlockPin = String(body.emergency_pin ?? body.emergencyPin ?? body.pin ?? '').trim()

    if (!email || !credential || !unlockPin || !deviceFingerprint) {
      return res.status(400).json({
        ok: false,
        error: 'email, password (or login pin), emergency pin, device_fingerprint required',
      })
    }

    if (!allowedAdminLoginEmail(email)) {
      adminAuthAudit('login_failure', { email, reason: 'emergency_email_not_allowed' })
      return res.status(401).json({ ok: false, error: 'Invalid credentials' })
    }

    const user = await authStore.findAdminUserByEmail(email)
    if (!user || !(await verifyAdminLoginCredential(user, credential))) {
      adminAuthAudit('login_failure', { email, reason: 'emergency_bad_credentials' })
      return res.status(401).json({ ok: false, error: 'Invalid credentials' })
    }

    if (!(await billing.verifyManualSubscriptionGrantPin(unlockPin))) {
      adminAuthAudit('login_failure', { email, reason: 'emergency_bad_pin' })
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }

    const fpHash = authStore.hashAdminDeviceFingerprint(deviceFingerprint)
    const ttl = Math.min(86400, Math.max(600, Number(process.env.ADMIN_EMERGENCY_SESSION_SECONDS) || 7200))
    const { token } = await issueSession(res, req, {
      user,
      fpHash,
      deviceRow: null,
      emergency: true,
      ttlSeconds: ttl,
    })
    adminAuthAudit('emergency_pin_access', { email })
    await authStore.recordSecurityEvent({
      adminUserId: user.id,
      eventType: 'emergency_pin_access',
      result: 'ok',
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    })
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
            status: authStore.deriveStatus(row),
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

    if (req.adminJti) {
      await authStore.revokeSessionByJti(req.adminJti)
    }

    let deviceRow = null
    if (!req.adminEmergency) {
      deviceRow = await authStore.getTrustedDeviceRow(req.adminUserId, fpHash)
      if (deviceRow?.id) await authStore.touchTrustedDeviceLastUsed(deviceRow.id)
    }

    const ttl = sessionTtlSecondsForDevice(deviceRow, { emergency: req.adminEmergency === true })

    const { token } = await issueSession(res, req, {
      user,
      fpHash,
      deviceRow,
      emergency: req.adminEmergency === true,
      ttlSeconds: ttl,
    })
    adminAuthAudit('session_refresh', { email: req.adminEmail })
    res.json({
      ok: true,
      token,
      email: user.email,
      trustedExpiresAt: deviceRow ? isoDate(deviceRow.trusted_expires_at) : null,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Security Center page gate — same admin auth as other panel routes (legacy token or JWT). */
adminAuthRouter.post('/verify-security-pin', requireAdminPanelAccess, (req, res) => {
  const pin = adminSecurityPinFromBody(req)
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'security_pin required' })
  }
  if (!verifyAdminSecurityPin(pin)) {
    adminAuthAudit('security_pin_denied', {
      email: req.adminAuth?.email ?? req.adminEmail ?? 'legacy',
      gate: 'security_center',
    })
    return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
  }
  adminAuthAudit('security_pin_gate_ok', {
    email: req.adminAuth?.email ?? req.adminEmail ?? 'legacy',
    gate: 'security_center',
  })
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
const DESTRUCTIVE_REVOKE_DEVICES = 'revoke_devices'
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
  if (action === DESTRUCTIVE_DELETE_DEVICES || action === DESTRUCTIVE_REVOKE_DEVICES) {
    const ids = Array.isArray(b.deviceIds ?? b.device_ids)
      ? (b.deviceIds ?? b.device_ids).map((x) => String(x).trim()).filter(Boolean)
      : []
    if (ids.length === 0) throw new Error('deviceIds required')
    return { type: action, payload: { deviceIds: ids } }
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

      if (actionType === DESTRUCTIVE_DELETE_DEVICES || actionType === DESTRUCTIVE_REVOKE_DEVICES) {
        const deviceIds = Array.isArray(payload.deviceIds)
          ? payload.deviceIds.map((x) => String(x).trim()).filter(Boolean)
          : []
        if (deviceIds.length === 0) {
          return res.status(400).json({ ok: false, error: 'No devices in challenge', affected: 0 })
        }
        const curHash = currentSessionFingerprintHash(req)
        for (const id of deviceIds) {
          const row = await authStore.getTrustedDeviceRowById(id, req.adminUserId)
          if (row?.device_fingerprint_hash === curHash && !confirmCurrent) {
            return sendCurrentDeviceConfirm(res)
          }
        }
        const hardDelete = actionType === DESTRUCTIVE_DELETE_DEVICES
        const affected = hardDelete
          ? await authStore.deleteTrustedDevicesBulk(deviceIds, req.adminUserId)
          : await authStore.revokeTrustedDevicesBulk(deviceIds, req.adminUserId)
        if (affected === 0) {
          return res.status(409).json({
            ok: false,
            error: 'No matching devices were updated (already revoked/removed?)',
            affected: 0,
            action: actionType,
          })
        }
        adminAuthAudit(hardDelete ? 'devices_bulk_removed' : 'devices_bulk_revoked', {
          email: req.adminEmail,
          count: affected,
          device_ids: deviceIds,
        })
        // Audit to admin_panel_security_events only — do NOT re-seed security_events after a wipe/revoke.
        await authStore.recordSecurityEvent({
          adminUserId: req.adminUserId,
          eventType: hardDelete ? 'devices_bulk_deleted' : 'devices_bulk_revoked',
          result: 'ok',
          ip: clientIp(req),
          userAgent: String(req.headers['user-agent'] ?? ''),
          metadata: { affected, device_ids: deviceIds },
        })
        return res.json({
          ok: true,
          deleted: affected,
          affected,
          action: actionType,
        })
      }

      if (actionType === DESTRUCTIVE_DELETE_ALL_LOGS) {
        // Permanent hard-delete of Admin security history + revoked session rows.
        // Do NOT write back into security_events afterward (that made "delete all" look broken).
        const ev = await pool.query(`DELETE FROM security_events`)
        let adminEv = { rowCount: 0 }
        let sess = { rowCount: 0 }
        try {
          adminEv = await pool.query(`DELETE FROM admin_panel_security_events`)
        } catch {
          /* table may not exist on older DBs */
        }
        try {
          // Remove all server-side admin session rows (JWTs become invalid on next jti check).
          sess = await pool.query(`DELETE FROM admin_panel_sessions`)
        } catch {
          /* table may not exist on older DBs */
        }
        const deletedEvents = Number(ev.rowCount) || 0
        const deletedAdminEvents = Number(adminEv.rowCount) || 0
        const deletedSessions = Number(sess.rowCount) || 0
        const deleted = deletedEvents + deletedAdminEvents + deletedSessions
        emitSecurityLogsSync({
          action: 'bulk_delete',
          deleted: deletedEvents,
          deletedAdminEvents,
          deletedSessions,
          mode: 'all',
          source: 'admin_security',
        })
        adminAuthAudit('security_logs_cleared', {
          email: req.adminEmail,
          deleted,
          deletedEvents,
          deletedAdminEvents,
          deletedSessions,
        })
        return res.json({
          ok: true,
          deleted,
          deletedEvents,
          deletedAdminEvents,
          deletedSessions,
          action: actionType,
        })
      }

      return res.status(400).json({ ok: false, error: 'Unknown destructive action' })
    } catch (e) {
      const msg = String(e.message || e)
      // Avoid re-seeding security_events after a failed wipe either.
      adminAuthAudit('destructive_action_failed', { email: req.adminEmail, error: msg.slice(0, 200) })
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
    const mapped = rows.map((r) => mapDeviceRow(r, currentHash))
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
      await authStore.recordSecurityEvent({
        adminUserId: req.adminUserId,
        eventType: 'device_blocked',
        result: 'ok',
        deviceId: req.params.id,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
      })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) })
    }
  },
)

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
  },
)

adminAuthRouter.post(
  '/devices/:id/revoke',
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
      const ok = await authStore.revokeTrustedDevice(req.params.id, req.adminUserId)
      if (!ok) return res.status(404).json({ ok: false, error: 'Device not found' })
      adminAuthAudit('device_revoked', { device_id: req.params.id })
      await authStore.recordSecurityEvent({
        adminUserId: req.adminUserId,
        eventType: 'device_revoked',
        result: 'ok',
        deviceId: req.params.id,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
      })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) })
    }
  },
)

/** Soft-revoke (keeps REVOKED audit row). Hard-delete is DELETE /devices/:id. */
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
      await authStore.recordSecurityEvent({
        adminUserId: req.adminUserId,
        eventType: 'device_hard_deleted',
        result: 'ok',
        deviceId: req.params.id,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
      })
      res.json({ ok: true, deleted: 1 })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) })
    }
  },
)

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
  },
)

adminAuthRouter.post('/logout', async (req, res) => {
  try {
    const token = readAdminSessionToken(req)
    const payload = token ? verifyAdminJwt(token) : null
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    // Normal logout ends the session only. Trusted-device credential survives for the
    // fixed 14-day window unless revoke_device / clear_device_credential is requested.
    const clearDevice =
      body.revoke_device === true ||
      body.clear_device_credential === true ||
      body.global === true

    if (body.global === true && payload?.sub) {
      await authStore.revokeAllSessionsForUser(payload.sub)
    } else if (payload?.jti) {
      await authStore.revokeSessionByJti(payload.jti)
    }

    if (clearDevice) {
      clearAdminAuthCookies(res, req)
    } else {
      clearAdminSessionCookie(res, req)
    }
    if (payload?.sub) {
      await authStore.recordSecurityEvent({
        adminUserId: payload.sub,
        eventType: body.global === true ? 'logout_all_sessions' : 'logout',
        result: 'ok',
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
        metadata: { cleared_device_credential: clearDevice === true },
      })
    }
    res.json({ ok: true, clearedDeviceCredential: clearDevice === true })
  } catch (e) {
    try {
      clearAdminSessionCookie(res, req)
    } catch {
      /* ignore */
    }
    res.json({ ok: true })
  }
})
