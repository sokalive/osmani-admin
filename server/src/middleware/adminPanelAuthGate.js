import * as authStore from '../adminAuthStore.js'
import { verifyAdminJwt } from '../lib/adminJwt.js'
import { readAdminSessionToken } from '../lib/adminAuthCookies.js'

function legacyTokenMatches(req) {
  const expected = String(process.env.APP_UPDATE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
  if (!expected) return false
  const got = String(req.headers['x-admin-token'] ?? '').trim()
  return got === expected
}

export function isAdminPanelAuthRequired() {
  return String(process.env.ADMIN_PANEL_AUTH_REQUIRED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Protects admin APIs.
 * When ADMIN_PANEL_AUTH_REQUIRED=true: Bearer JWT or HttpOnly session cookie (+ device fingerprint),
 * device must be trusted/active; blocked devices get 403 DEVICE_BLOCKED.
 * Optional ADMIN_PANEL_LEGACY_TOKEN_FALLBACK=true allows X-Admin-Token during migration only.
 */
export async function requireAdminPanelAccess(req, res, next) {
  try {
    if (!isAdminPanelAuthRequired()) {
      const expected = String(process.env.APP_UPDATE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
      if (!expected) {
        return res.status(503).json({ ok: false, error: 'ADMIN_API_TOKEN / APP_UPDATE_ADMIN_TOKEN is not configured' })
      }
      const got = String(req.headers['x-admin-token'] ?? '').trim()
      if (got !== expected) {
        return res.status(403).json({ ok: false, error: 'Invalid admin token' })
      }
      return next()
    }

    const fallback =
      String(process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK ?? '').trim().toLowerCase() === 'true'
    if (fallback && legacyTokenMatches(req)) {
      req.adminAuth = { legacy: true }
      return next()
    }

    const token = readAdminSessionToken(req)
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Admin session required', code: 'NO_SESSION' })
    }
    const payload = verifyAdminJwt(token)
    if (!payload?.sub || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session', code: 'INVALID_SESSION' })
    }

    if (payload.typ === 'otp_pending' || payload.typ === 'admin_security_gate') {
      return res.status(401).json({ ok: false, error: 'Invalid session type', code: 'INVALID_SESSION' })
    }

    const rawFp = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    const fpHeader = authStore.hashAdminDeviceFingerprint(rawFp)
    if (!rawFp || fpHeader !== payload.fp) {
      return res.status(401).json({ ok: false, error: 'Device fingerprint required', code: 'DEVICE_MISMATCH' })
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
      req.adminAuth = {
        userId: payload.sub,
        email: payload.em,
        emergency: true,
        jti: payload.jti,
      }
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
      return res.status(403).json({ ok: false, error: 'Verification required again', code: 'FORCE_OTP' })
    }
    if (payload.sv != null && Number(payload.sv) !== Number(row.session_version || 1)) {
      return res.status(401).json({
        ok: false,
        error: 'Session invalidated',
        code: 'SESSION_REVOKED',
      })
    }

    void authStore.touchTrustedDeviceLastUsed(row.id)

    req.adminAuth = {
      userId: payload.sub,
      email: payload.em,
      emergency: false,
      deviceId: row.id,
      jti: payload.jti,
    }
    return next()
  } catch (e) {
    return next(e)
  }
}
