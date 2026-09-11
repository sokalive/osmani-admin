import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { getPool } from './db/pool.js'
import { hashAdminDeviceFingerprint, hashOtpCode } from './lib/adminFingerprint.js'
import {
  generateAdminDeviceCredential,
  hashAdminDeviceCredential,
} from './lib/adminDeviceCredential.js'
import { getConfiguredAdminLoginPin } from './lib/adminLoginPin.js'

function pool() {
  const p = getPool()
  if (!p) throw new Error('DATABASE_URL required for admin panel auth')
  return p
}

export { hashAdminDeviceFingerprint, generateAdminDeviceCredential, hashAdminDeviceCredential }

/** Exact trusted-device lifetime: 14 days = 336 hours (server-authoritative, non-sliding). */
export const TRUSTED_DEVICE_TTL_DAYS = Math.min(
  90,
  Math.max(1, Number(process.env.ADMIN_TRUSTED_DEVICE_DAYS) || 14),
)
export const TRUSTED_DEVICE_TTL_SECONDS = TRUSTED_DEVICE_TTL_DAYS * 86400

export function trustedExpiresAtFrom(now = new Date()) {
  const base = now instanceof Date ? now.getTime() : Date.now()
  return new Date(base + TRUSTED_DEVICE_TTL_SECONDS * 1000)
}

export function isTrustedDeviceExpired(row) {
  if (!row) return true
  if (row.trusted_expires_at == null) return true
  const expMs =
    row.trusted_expires_at instanceof Date
      ? row.trusted_expires_at.getTime()
      : new Date(row.trusted_expires_at).getTime()
  return !Number.isFinite(expMs) || Date.now() >= expMs
}

/** ACTIVE trusted device within the fixed 14-day window (not blocked/revoked/force-otp/expired). */
export function isTrustedDeviceActive(row) {
  if (!row) return false
  if (row.blocked === true || row.status === 'BLOCKED') return false
  if (row.revoked_at || row.status === 'REVOKED') return false
  if (row.force_otp_next === true) return false
  if (row.trusted !== true) return false
  if (isTrustedDeviceExpired(row)) return false
  return true
}

/** Remaining trust seconds (0 if expired/missing). */
export function trustedDeviceRemainingSeconds(row) {
  if (!row?.trusted_expires_at) return 0
  const expMs =
    row.trusted_expires_at instanceof Date
      ? row.trusted_expires_at.getTime()
      : new Date(row.trusted_expires_at).getTime()
  if (!Number.isFinite(expMs)) return 0
  return Math.max(0, Math.floor((expMs - Date.now()) / 1000))
}

function deriveStatus(row) {
  if (!row) return 'UNKNOWN'
  if (row.revoked_at || row.status === 'REVOKED') return 'REVOKED'
  if (row.blocked === true || row.status === 'BLOCKED') return 'BLOCKED'
  if (isTrustedDeviceExpired(row) && row.trusted === true) return 'EXPIRED'
  if (row.trusted === true && row.force_otp_next !== true) return 'ACTIVE'
  if (row.force_otp_next === true) return 'NEW'
  return row.trusted ? 'ACTIVE' : 'NEW'
}

export async function ensureBootstrapAdminPanelUser() {
  const email = String(process.env.ADMIN_PANEL_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase()
  const pinEnv = getConfiguredAdminLoginPin()
  const plain =
    String(process.env.ADMIN_PANEL_BOOTSTRAP_PASSWORD ?? '').trim() || pinEnv
  if (!email || !plain || plain.length < 4) return

  const p = pool()
  const { rows: existing } = await p.query(
    `SELECT id, password_hash FROM admin_panel_users WHERE lower(email) = $1 LIMIT 1`,
    [email],
  )
  if (existing[0]) {
    // Keep hash in sync with ADMIN_LOGIN_PIN / bootstrap password when provided.
    if (pinEnv || process.env.ADMIN_PANEL_BOOTSTRAP_PASSWORD) {
      const ok = await bcrypt.compare(plain, existing[0].password_hash)
      if (!ok) {
        const password_hash = await bcrypt.hash(plain, 12)
        await p.query(
          `UPDATE admin_panel_users SET password_hash = $2, updated_at = now() WHERE id = $1`,
          [existing[0].id, password_hash],
        )
      }
    }
    return
  }

  const { rows: countRows } = await p.query(`SELECT COUNT(*)::int AS n FROM admin_panel_users`)
  if (Number(countRows[0]?.n) > 0 && !pinEnv) return

  const password_hash = await bcrypt.hash(plain, 12)
  await p.query(
    `INSERT INTO admin_panel_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [email, password_hash],
  )
}

export async function findAdminUserByEmail(email) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return null
  const { rows } = await pool().query(`SELECT * FROM admin_panel_users WHERE lower(email) = $1 LIMIT 1`, [e])
  return rows[0] ?? null
}

export async function findAdminUserById(id) {
  const { rows } = await pool().query(`SELECT * FROM admin_panel_users WHERE id = $1 LIMIT 1`, [id])
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
       AND revoked_at IS NULL
     LIMIT 1`,
    [userId, fpHash],
  )
  return rows[0] ?? null
}

export async function getTrustedDeviceByCredentialHash(credHash) {
  if (!credHash) return null
  const { rows } = await pool().query(
    `SELECT d.*, u.email AS admin_email
     FROM admin_panel_trusted_devices d
     JOIN admin_panel_users u ON u.id = d.admin_user_id
     WHERE d.device_credential_hash = $1
     LIMIT 1`,
    [credHash],
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
  await pool().query(
    `UPDATE admin_panel_trusted_devices
     SET last_used_at = now(), updated_at = now()
     WHERE id = $1`,
    [deviceRowId],
  )
}

export async function clearForceOtpOnDevice(deviceRowId) {
  await pool().query(
    `UPDATE admin_panel_trusted_devices
     SET force_otp_next = false, status = 'ACTIVE', updated_at = now()
     WHERE id = $1`,
    [deviceRowId],
  )
}

/**
 * Upsert trusted device after OTP. Returns { row, deviceCredentialPlain, isNewDevice }.
 */
export async function upsertTrustedDevice({
  userId,
  fpHash,
  deviceName,
  browser,
  ip,
  deviceType,
  osName,
  userAgent,
  country,
  region,
  city,
  isp,
  rotateCredential = true,
}) {
  const existing = await getTrustedDeviceRow(userId, fpHash)
  const isNewDevice = !existing
  let deviceCredentialPlain = null
  let credentialHash = existing?.device_credential_hash || null

  if (rotateCredential || !credentialHash) {
    deviceCredentialPlain = generateAdminDeviceCredential()
    credentialHash = hashAdminDeviceCredential(deviceCredentialPlain)
  }

  // Fixed trust window starts at OTP enrollment / re-verification — not slid on every visit.
  const trustedExpiresAt = trustedExpiresAtFrom()

  const { rows } = await pool().query(
    `INSERT INTO admin_panel_trusted_devices
       (admin_user_id, device_fingerprint_hash, device_credential_hash, device_name, browser,
        ip_address, device_type, os_name, user_agent, country, region, city, isp,
        trusted, blocked, force_otp_next, status, last_used_at, last_login_at, updated_at,
        trusted_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             true, false, false, 'ACTIVE', now(), now(), now(), $14)
     ON CONFLICT (admin_user_id, device_fingerprint_hash)
     DO UPDATE SET
       device_credential_hash = COALESCE(EXCLUDED.device_credential_hash, admin_panel_trusted_devices.device_credential_hash),
       device_name = EXCLUDED.device_name,
       browser = EXCLUDED.browser,
       ip_address = EXCLUDED.ip_address,
       device_type = EXCLUDED.device_type,
       os_name = EXCLUDED.os_name,
       user_agent = EXCLUDED.user_agent,
       country = EXCLUDED.country,
       region = EXCLUDED.region,
       city = EXCLUDED.city,
       isp = EXCLUDED.isp,
       trusted = true,
       blocked = false,
       force_otp_next = false,
       status = 'ACTIVE',
       revoked_at = NULL,
       blocked_at = NULL,
       last_used_at = now(),
       last_login_at = now(),
       trusted_expires_at = EXCLUDED.trusted_expires_at,
       updated_at = now(),
       session_version = admin_panel_trusted_devices.session_version + CASE
         WHEN EXCLUDED.device_credential_hash IS DISTINCT FROM admin_panel_trusted_devices.device_credential_hash
         THEN 1 ELSE 0 END
     RETURNING *`,
    [
      userId,
      fpHash,
      credentialHash,
      String(deviceName ?? '').slice(0, 200),
      String(browser ?? '').slice(0, 400),
      String(ip ?? '').slice(0, 80),
      String(deviceType ?? '').slice(0, 40),
      String(osName ?? '').slice(0, 80),
      String(userAgent ?? '').slice(0, 500),
      String(country ?? '').slice(0, 80),
      String(region ?? '').slice(0, 120),
      String(city ?? '').slice(0, 120),
      String(isp ?? '').slice(0, 160),
      trustedExpiresAt,
    ],
  )
  return { row: rows[0] ?? null, deviceCredentialPlain, isNewDevice }
}

/**
 * Test/ops helper: set trusted_expires_at for a device without touching production clock.
 * Does not print credentials. Used by controlled expiration verification only.
 */
export async function setTrustedDeviceExpiresAtForTest(deviceId, userId, expiresAt) {
  const { rows } = await pool().query(
    `UPDATE admin_panel_trusted_devices
        SET trusted_expires_at = $3::timestamptz, updated_at = now()
      WHERE id = $1 AND admin_user_id = $2
      RETURNING id, trusted_expires_at, status, blocked, revoked_at`,
    [deviceId, userId, expiresAt],
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
    `SELECT id, device_fingerprint_hash, device_name, browser, ip_address, device_type, os_name,
            user_agent, country, region, city, isp, trusted, blocked, force_otp_next, status,
            created_at, last_used_at, last_login_at, blocked_at, revoked_at, updated_at,
            trusted_expires_at, session_version
     FROM admin_panel_trusted_devices
     WHERE admin_user_id = $1
     ORDER BY COALESCE(last_used_at, created_at) DESC`,
    [userId],
  )
  return rows.map((r) => ({ ...r, derived_status: deriveStatus(r) }))
}

export async function setDeviceBlocked(deviceId, userId, blocked) {
  const { rowCount } = await pool().query(
    blocked
      ? `UPDATE admin_panel_trusted_devices
         SET blocked = true, status = 'BLOCKED', blocked_at = now(), updated_at = now(),
             session_version = session_version + 1,
             device_credential_hash = NULL
         WHERE id = $1 AND admin_user_id = $2`
      : `UPDATE admin_panel_trusted_devices
         SET blocked = false, status = 'ACTIVE', blocked_at = NULL, force_otp_next = true,
             updated_at = now()
         WHERE id = $1 AND admin_user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId],
  )
  if (blocked && Number(rowCount) > 0) {
    await revokeSessionsForDevice(deviceId)
  }
  return Number(rowCount) > 0
}

/** Soft-revoke: keep audit row, invalidate credential + sessions. */
export async function revokeTrustedDevice(deviceId, userId) {
  const { rowCount } = await pool().query(
    `UPDATE admin_panel_trusted_devices
     SET status = 'REVOKED', revoked_at = now(), trusted = false, blocked = false,
         device_credential_hash = NULL, force_otp_next = true,
         session_version = session_version + 1, updated_at = now()
     WHERE id = $1 AND admin_user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId],
  )
  if (Number(rowCount) > 0) await revokeSessionsForDevice(deviceId)
  return Number(rowCount) > 0
}

export async function revokeTrustedDevicesBulk(deviceIds, userId) {
  const ids = Array.isArray(deviceIds) ? deviceIds.map((x) => String(x).trim()).filter(Boolean) : []
  if (ids.length === 0) return 0
  let n = 0
  for (const id of ids) {
    if (await revokeTrustedDevice(id, userId)) n += 1
  }
  return n
}

/**
 * Hard-delete device after invalidating credential + sessions.
 * Row disappears from Security Center permanently.
 */
export async function deleteTrustedDevice(deviceId, userId) {
  await revokeTrustedDevice(deviceId, userId)
  await revokeSessionsForDevice(deviceId)
  const { rowCount } = await pool().query(
    `DELETE FROM admin_panel_trusted_devices WHERE id = $1 AND admin_user_id = $2`,
    [deviceId, userId],
  )
  return Number(rowCount) > 0
}

export async function deleteTrustedDevicesBulk(deviceIds, userId) {
  const ids = Array.isArray(deviceIds) ? deviceIds.map((x) => String(x).trim()).filter(Boolean) : []
  if (ids.length === 0) return 0
  let n = 0
  for (const id of ids) {
    if (await deleteTrustedDevice(id, userId)) n += 1
  }
  return n
}

export async function setDeviceForceOtp(deviceId, userId, force = true) {
  const { rowCount } = await pool().query(
    `UPDATE admin_panel_trusted_devices
     SET force_otp_next = $3, status = CASE WHEN $3 THEN 'NEW' ELSE status END,
         session_version = session_version + 1, updated_at = now(),
         device_credential_hash = CASE WHEN $3 THEN NULL ELSE device_credential_hash END
     WHERE id = $1 AND admin_user_id = $2 AND blocked = false AND revoked_at IS NULL`,
    [deviceId, userId, Boolean(force)],
  )
  if (force && Number(rowCount) > 0) await revokeSessionsForDevice(deviceId)
  return Number(rowCount) > 0
}

export async function createAdminSession({
  userId,
  deviceId,
  jti,
  expiresAt,
  ip,
  userAgent,
}) {
  await pool().query(
    `INSERT INTO admin_panel_sessions
       (admin_user_id, device_id, session_jti, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      deviceId || null,
      jti,
      expiresAt,
      String(ip ?? '').slice(0, 80),
      String(userAgent ?? '').slice(0, 400),
    ],
  )
}

export async function getActiveSessionByJti(jti) {
  if (!jti) return null
  const { rows } = await pool().query(
    `SELECT * FROM admin_panel_sessions
     WHERE session_jti = $1 AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [jti],
  )
  return rows[0] ?? null
}

export async function touchSession(jti) {
  if (!jti) return
  await pool().query(
    `UPDATE admin_panel_sessions SET last_seen_at = now() WHERE session_jti = $1 AND revoked_at IS NULL`,
    [jti],
  )
}

export async function revokeSessionByJti(jti) {
  if (!jti) return
  await pool().query(
    `UPDATE admin_panel_sessions SET revoked_at = now() WHERE session_jti = $1 AND revoked_at IS NULL`,
    [jti],
  )
}

export async function revokeSessionsForDevice(deviceId) {
  if (!deviceId) return
  await pool().query(
    `UPDATE admin_panel_sessions SET revoked_at = now()
     WHERE device_id = $1 AND revoked_at IS NULL`,
    [deviceId],
  )
}

export async function revokeAllSessionsForUser(userId) {
  await pool().query(
    `UPDATE admin_panel_sessions SET revoked_at = now()
     WHERE admin_user_id = $1 AND revoked_at IS NULL`,
    [userId],
  )
}

export async function recordSecurityEvent({
  adminUserId,
  eventType,
  result = 'ok',
  deviceId = null,
  ip = '',
  userAgent = '',
  metadata = {},
}) {
  try {
    await pool().query(
      `INSERT INTO admin_panel_security_events
         (admin_user_id, event_type, result, device_id, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        adminUserId || null,
        String(eventType).slice(0, 120),
        String(result).slice(0, 40),
        deviceId || null,
        String(ip ?? '').slice(0, 80),
        String(userAgent ?? '').slice(0, 400),
        JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
      ],
    )
  } catch (e) {
    console.warn('[admin-auth] security event write failed', e?.message || e)
  }
}

export function generateOtp6() {
  const n = crypto.randomInt(0, 1_000_000)
  return String(n).padStart(6, '0')
}

export function newSessionJti() {
  return crypto.randomUUID()
}

export { deriveStatus }
