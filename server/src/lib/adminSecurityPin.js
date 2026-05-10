import crypto from 'node:crypto'

export function getAdminSecurityPin() {
  return String(process.env.ADMIN_SECURITY_PIN ?? '3030')
}

/** Compare PIN without leaking expected length via early exit. */
export function verifyAdminSecurityPin(input) {
  const expected = getAdminSecurityPin()
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
