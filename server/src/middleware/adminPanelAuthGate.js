import * as authStore from '../adminAuthStore.js'
import { verifyAdminJwt } from '../lib/adminJwt.js'
import { readAdminSessionToken } from '../lib/adminAuthCookies.js'
import { schedulePrivilegedAudit } from '../lib/privilegedAuditLog.js'

/**
 * Panel login is always required. ADMIN_PANEL_AUTH_REQUIRED=false, ADMIN_TRUSTED_INSTALL,
 * LUQMAN_VPS, and X-Admin-Token cannot open privileged routes.
 */
export function isAdminPanelAuthRequired() {
  return true
}

/**
 * Protects admin APIs with a server session JWT (Authorization bearer or HttpOnly cookie),
 * a matching device fingerprint, and an active session row.
 * A permanent X-Admin-Token is never accepted.
 */
export async function requireAdminPanelAccess(req, res, next) {
  try {
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
      schedulePrivilegedAudit(req, res)
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
    schedulePrivilegedAudit(req, res)
    return next()
  } catch (e) {
    return next(e)
  }
}
