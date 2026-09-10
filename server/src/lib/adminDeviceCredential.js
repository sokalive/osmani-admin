import crypto from 'node:crypto'

/** Cryptographically secure device credential (never stored plaintext). */
export function generateAdminDeviceCredential() {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashAdminDeviceCredential(plain) {
  const salt = String(process.env.ADMIN_DEVICE_CREDENTIAL_SALT || process.env.ADMIN_DEVICE_FP_SALT || 'osmani-admin-device-cred-v1').trim()
  return crypto.createHash('sha256').update(`${salt}::${String(plain ?? '').trim()}`).digest('hex')
}

export function timingSafeEqualHex(a, b) {
  const aa = String(a ?? '')
  const bb = String(b ?? '')
  if (!aa || !bb || aa.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(aa, 'utf8'), Buffer.from(bb, 'utf8'))
  } catch {
    return false
  }
}
