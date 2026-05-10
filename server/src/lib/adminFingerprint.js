import crypto from 'node:crypto'

export function hashAdminDeviceFingerprint(raw) {
  const salt = String(process.env.ADMIN_DEVICE_FP_SALT || 'osmani-admin-device-v1').trim()
  return crypto.createHash('sha256').update(`${salt}::${String(raw ?? '').trim()}`).digest('hex')
}

export function hashOtpCode(code) {
  const salt = String(process.env.ADMIN_OTP_HASH_SALT || 'osmani-admin-otp-v1').trim()
  return crypto.createHash('sha256').update(`${salt}::${String(code ?? '').trim()}`).digest('hex')
}
