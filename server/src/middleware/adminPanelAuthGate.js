import * as authStore from '../adminAuthStore.js'
import { verifyAdminJwt } from '../lib/adminJwt.js'

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
 * Protects manual-subscription + offer-codes admin APIs.
 * When ADMIN_PANEL_AUTH_REQUIRED=true: requires Bearer JWT (+ device fingerprint header),
 * unless ADMIN_PANEL_LEGACY_TOKEN_FALLBACK=true and X-Admin-Token matches (migration).
 * Otherwise: legacy X-Admin-Token only (unchanged).
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

    const auth = String(req.headers.authorization ?? '')
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (!m) {
      return res.status(401).json({ ok: false, error: 'Admin session required', code: 'NO_SESSION' })
    }
    const payload = verifyAdminJwt(m[1].trim())
    if (!payload?.sub || !payload.fp) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session', code: 'INVALID_SESSION' })
    }

    const rawFp = String(req.headers['x-admin-device-fingerprint'] ?? '').trim()
    const fpHeader = authStore.hashAdminDeviceFingerprint(rawFp)
    if (!rawFp || fpHeader !== payload.fp) {
      return res.status(401).json({ ok: false, error: 'Device fingerprint required', code: 'DEVICE_MISMATCH' })
    }

    if (payload.emerg === true) {
      req.adminAuth = {
        userId: payload.sub,
        email: payload.em,
        emergency: true,
      }
      return next()
    }

    const row = await authStore.getTrustedDeviceRow(payload.sub, payload.fp)
    if (!row) {
      return res.status(403).json({ ok: false, error: 'Trusted device removed — sign in again', code: 'DEVICE_REVOKED' })
    }
    if (row.blocked === true) {
      return res.status(403).json({ ok: false, error: 'This device is blocked', code: 'DEVICE_BLOCKED' })
    }
    if (row.force_otp_next === true) {
      return res.status(403).json({ ok: false, error: 'Verification required again', code: 'FORCE_OTP' })
    }

    req.adminAuth = {
      userId: payload.sub,
      email: payload.em,
      emergency: false,
    }
    return next()
  } catch (e) {
    return next(e)
  }
}
