/**
 * Shared password gate for admin-sensitive UI actions only (not login / OTP).
 * Used by: Toa Kifurushi (grant), Security Center, Admin Security.
 */
import crypto from 'node:crypto'

const DEFAULT_PASSWORD = '3030'

export function getAdminSensitiveActionPassword() {
  return String(process.env.ADMIN_SENSITIVE_ACTION_PASSWORD ?? DEFAULT_PASSWORD).trim()
}

export function verifyAdminSensitiveActionPassword(input) {
  const expected = getAdminSensitiveActionPassword()
  const a = crypto.createHash('sha256').update(Buffer.from(expected, 'utf8')).digest()
  const b = crypto.createHash('sha256').update(Buffer.from(String(input ?? ''), 'utf8')).digest()
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function sensitiveActionPasswordFromBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  return String(
    body.security_pin ?? body.securityPin ?? body.pin ?? body.password ?? '',
  ).trim()
}
