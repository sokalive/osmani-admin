import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

/**
 * Admin login PIN — server-only. Never embed in frontend.
 * Prefer ADMIN_LOGIN_PIN env; otherwise verify against admin_panel_users.password_hash.
 */
export function getConfiguredAdminLoginPin() {
  return String(process.env.ADMIN_LOGIN_PIN ?? '').trim()
}

export function verifyConfiguredAdminLoginPin(input) {
  const expected = getConfiguredAdminLoginPin()
  if (!expected) return false
  const a = crypto.createHash('sha256').update(Buffer.from(expected, 'utf8')).digest()
  const b = crypto.createHash('sha256').update(Buffer.from(String(input ?? ''), 'utf8')).digest()
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function verifyAdminLoginCredential(userRow, pinOrPassword) {
  const plain = String(pinOrPassword ?? '')
  if (!plain) return false
  if (getConfiguredAdminLoginPin() && verifyConfiguredAdminLoginPin(plain)) {
    return true
  }
  if (!userRow?.password_hash) return false
  return bcrypt.compare(plain, userRow.password_hash)
}

export function allowedAdminLoginEmail(email) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return false
  const bootstrap = String(process.env.ADMIN_PANEL_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase()
  const allowList = String(process.env.ADMIN_LOGIN_EMAILS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (allowList.length > 0) return allowList.includes(e)
  if (bootstrap) return e === bootstrap
  return true
}
