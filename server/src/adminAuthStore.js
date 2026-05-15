import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { getPool } from './db/pool.js'
import { hashAdminDeviceFingerprint, hashOtpCode } from './lib/adminFingerprint.js'

function pool() {
  const p = getPool()
  if (!p) throw new Error('DATABASE_URL required for admin panel auth')
  return p
}

export { hashAdminDeviceFingerprint }

export async function ensureBootstrapAdminPanelUser() {
  const email = String(process.env.ADMIN_PANEL_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase()
  const plain = String(process.env.ADMIN_PANEL_BOOTSTRAP_PASSWORD ?? '').trim()
  if (!email || plain.length < 8) return

  const p = pool()
  const { rows } = await p.query(`SELECT COUNT(*)::int AS n FROM admin_panel_users`)
  if (Number(rows[0]?.n) > 0) return

  const password_hash = await bcrypt.hash(plain, 12)
  await p.query(
    `INSERT INTO admin_panel_users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [email, password_hash],
  )
}

export async function findAdminUserByEmail(email) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return null
  const { rows } = await pool().query(`SELECT * FROM admin_panel_users WHERE lower(email) = $1 LIMIT 1`, [e])
  return rows[0] ?? null
}

export async function verifyAdminPassword(userRow, plain) {
  if (!userRow?.password_hash) return false
  return bcrypt.compare(String(plain ?? ''), userRow.password_hash)
}

export async function getTrustedDeviceRow(userId, fpHash) {
  const { rows } = await pool().query(
    `SELECT * FROM admin_panel_trusted_devices
     WHERE admin_user_id = $1 AND device_fingerprint_hash = $2
     LIMIT 1`,
    [userId, fpHash],
  )
  return rows[0] ?? null
}

export async function getTrustedDeviceRowById(deviceRowId, userId) {
  const { rows } = await pool().query(
    `SELECT * FROM admin_panel_trusted_devices WHERE id = $1 AND admin_user_id = $2 LIMIT 1`,
    [deviceRowId, userId],
  )
  return rows[0] ?? null
}

export async function touchTrustedDeviceLastUsed(deviceRowId) {
  await pool().query(`UPDATE admin_panel_trusted_devices SET last_used_at = now() WHERE id = $1`, [deviceRowId])
}

export async function clearForceOtpOnDevice(deviceRowId) {
  await pool().query(
    `UPDATE admin_panel_trusted_devices SET force_otp_next = false WHERE id = $1`,
    [deviceRowId],
  )
}

/** Upsert trusted device after OTP (or refresh metadata). */
export async function upsertTrustedDevice({
  userId,
  fpHash,
  deviceName,
  browser,
  ip,
}) {
  const { rows } = await pool().query(
    `INSERT INTO admin_panel_trusted_devices
       (admin_user_id, device_fingerprint_hash, device_name, browser, ip_address, trusted, blocked, force_otp_next, last_used_at)
     VALUES ($1, $2, $3, $4, $5, true, false, false, now())
     ON CONFLICT (admin_user_id, device_fingerprint_hash)
     DO UPDATE SET
       device_name = EXCLUDED.device_name,
       browser = EXCLUDED.browser,
       ip_address = EXCLUDED.ip_address,
       trusted = true,
       blocked = false,
       force_otp_next = false,
       last_used_at = now()
     RETURNING *`,
    [userId, fpHash, String(deviceName ?? '').slice(0, 200), String(browser ?? '').slice(0, 400), String(ip ?? '').slice(0, 80)],
  )
  return rows[0] ?? null
}

export async function invalidateActiveOtps(userId, fpHash) {
  await pool().query(
    `UPDATE admin_panel_login_otps SET used = true WHERE admin_user_id = $1 AND device_fingerprint_hash = $2 AND used = false`,
    [userId, fpHash],
  )
}

export async function insertLoginOtp({ userId, fpHash, codePlain }) {
  const code_hash = hashOtpCode(codePlain)
  const mins = Math.min(30, Math.max(1, Number(process.env.ADMIN_OTP_EXPIRY_MINUTES) || 5))
  const { rows } = await pool().query(
    `INSERT INTO admin_panel_login_otps (admin_user_id, code_hash, device_fingerprint_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'))
     RETURNING id, expires_at`,
    [userId, code_hash, fpHash, mins],
  )
  return rows[0] ?? null
}

export async function verifyLoginOtpActive({ userId, fpHash, codePlain }) {
  const code_hash = hashOtpCode(codePlain)
  const { rows } = await pool().query(
    `SELECT id FROM admin_panel_login_otps
     WHERE admin_user_id = $1 AND device_fingerprint_hash = $2 AND code_hash = $3
       AND used = false AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, fpHash, code_hash],
  )
  return rows[0]?.id ?? null
}

export async function markLoginOtpUsed(otpId) {
  await pool().query(`UPDATE admin_panel_login_otps SET used = true WHERE id = $1`, [otpId])
}

export async function listTrustedDevicesForUser(userId) {
  const { rows } = await pool().query(
    `SELECT id, device_fingerprint_hash, device_name, browser, ip_address, trusted, blocked, force_otp_next,
            created_at, last_used_at
     FROM admin_panel_trusted_devices
     WHERE admin_user_id = $1
     ORDER BY last_used_at DESC`,
    [userId],
  )
  return rows
}

export async function setDeviceBlocked(deviceId, userId, blocked) {
  const { rowCount } = await pool().query(
    `UPDATE admin_panel_trusted_devices SET blocked = $3 WHERE id = $1 AND admin_user_id = $2`,
    [deviceId, userId, Boolean(blocked)],
  )
  return Number(rowCount) > 0
}

export async function deleteTrustedDevice(deviceId, userId) {
  const { rowCount } = await pool().query(
    `DELETE FROM admin_panel_trusted_devices WHERE id = $1 AND admin_user_id = $2`,
    [deviceId, userId],
  )
  return Number(rowCount) > 0
}

export async function deleteTrustedDevicesBulk(deviceIds, userId) {
  const ids = Array.isArray(deviceIds) ? deviceIds.map((x) => String(x).trim()).filter(Boolean) : []
  if (ids.length === 0) return 0
  const { rowCount } = await pool().query(
    `DELETE FROM admin_panel_trusted_devices WHERE admin_user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, ids],
  )
  return Number(rowCount) || 0
}

export async function setDeviceForceOtp(deviceId, userId, force = true) {
  const { rowCount } = await pool().query(
    `UPDATE admin_panel_trusted_devices SET force_otp_next = $3 WHERE id = $1 AND admin_user_id = $2 AND blocked = false`,
    [deviceId, userId, Boolean(force)],
  )
  return Number(rowCount) > 0
}

export function generateOtp6() {
  const n = crypto.randomInt(0, 1_000_000)
  return String(n).padStart(6, '0')
}
