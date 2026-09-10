import crypto from 'node:crypto'

/**
 * Admin Security Center PIN — server env only (never ship to frontend).
 * Configure ADMIN_SECURITY_PIN in production. Empty default fails closed unless set.
 */
export function getAdminSecurityPin() {
  const fromEnv = String(process.env.ADMIN_SECURITY_PIN ?? '').trim()
  if (fromEnv) return fromEnv
  // Legacy local/dev fallback only when explicitly allowed.
  if (String(process.env.ADMIN_SECURITY_PIN_DEV_FALLBACK ?? '').trim() === '1') {
    return '1975'
  }
  return ''
}

/** Compare PIN without leaking expected length via early exit. */
export function verifyAdminSecurityPin(input) {
  const expected = getAdminSecurityPin()
  if (!expected) return false
  const a = crypto.createHash('sha256').update(Buffer.from(expected, 'utf8')).digest()
  const b = crypto.createHash('sha256').update(Buffer.from(String(input ?? ''), 'utf8')).digest()
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function adminSecurityPinFromBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  return String(body.security_pin ?? body.securityPin ?? '').trim()
}
