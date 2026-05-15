import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'
import { hashOtpCode } from './adminFingerprint.js'

const CHALLENGE_TTL_MINUTES = 15
const OTP_TTL_MINUTES = 5
const MAX_OTP_VERIFY_ATTEMPTS = 8
const MAX_OTP_SENDS_PER_CHALLENGE = 4
const MIN_RESEND_GAP_MS = 45_000

function pool() {
  const p = getPool()
  if (!p) throw new Error('Database not configured')
  return p
}

export function analyticsResetPassword() {
  return String(process.env.ANALYTICS_RESET_PASSWORD ?? '1975').trim()
}

export function analyticsResetAlertEmail() {
  return String(process.env.ADMIN_ALERT_EMAIL ?? '').trim().toLowerCase()
}

export function analyticsResetCooldownMinutes() {
  return Math.min(24 * 60, Math.max(5, Number(process.env.ANALYTICS_RESET_COOLDOWN_MINUTES) || 60))
}

export async function ensureAnalyticsResetTables(client) {
  const q = client || pool()
  await q.query(`
    CREATE TABLE IF NOT EXISTS analytics_reset_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge_token_hash TEXT NOT NULL UNIQUE,
      admin_user_id TEXT NOT NULL DEFAULT '',
      admin_email TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      device_label TEXT NOT NULL DEFAULT '',
      password_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      otp_hash TEXT,
      otp_expires_at TIMESTAMPTZ,
      otp_used BOOLEAN NOT NULL DEFAULT false,
      otp_verify_attempts INT NOT NULL DEFAULT 0,
      otp_sent_count INT NOT NULL DEFAULT 0,
      last_otp_sent_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_otp_verify_ok BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await q.query(`
    CREATE INDEX IF NOT EXISTS analytics_reset_challenges_completed_idx
    ON analytics_reset_challenges (completed_at DESC)
    WHERE completed_at IS NOT NULL;
  `)
}

function hashChallengeToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function generateOtp6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export function generateChallengeToken() {
  return crypto.randomBytes(32).toString('hex')
}

export async function getLastSuccessfulResetAt() {
  await ensureAnalyticsResetTables()
  const { rows } = await pool().query(
    `SELECT completed_at FROM analytics_reset_challenges
     WHERE completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 1`,
  )
  const t = rows[0]?.completed_at
  return t instanceof Date ? t : t ? new Date(t) : null
}

export async function assertResetCooldown() {
  const last = await getLastSuccessfulResetAt()
  if (!last || Number.isNaN(last.getTime())) return
  const mins = analyticsResetCooldownMinutes()
  const elapsed = Date.now() - last.getTime()
  if (elapsed < mins * 60 * 1000) {
    const waitMin = Math.ceil((mins * 60 * 1000 - elapsed) / 60_000)
    throw new Error(`Reset cooldown active. Try again in about ${waitMin} minute(s).`)
  }
}

export async function createPasswordVerifiedChallenge(meta) {
  await ensureAnalyticsResetTables()
  await assertResetCooldown()
  const token = generateChallengeToken()
  const tokenHash = hashChallengeToken(token)
  const { rows } = await pool().query(
    `INSERT INTO analytics_reset_challenges (
       challenge_token_hash, admin_user_id, admin_email, ip_address, user_agent, device_label
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, password_verified_at`,
    [
      tokenHash,
      String(meta.adminUserId ?? ''),
      String(meta.adminEmail ?? ''),
      String(meta.ip ?? '').slice(0, 80),
      String(meta.userAgent ?? '').slice(0, 400),
      String(meta.deviceLabel ?? '').slice(0, 200),
    ],
  )
  return {
    challengeToken: token,
    challengeId: String(rows[0]?.id),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60 * 1000).toISOString(),
  }
}

async function loadChallengeByToken(token) {
  const tokenHash = hashChallengeToken(token)
  const { rows } = await pool().query(
    `SELECT * FROM analytics_reset_challenges WHERE challenge_token_hash = $1 LIMIT 1`,
    [tokenHash],
  )
  return rows[0] ?? null
}

function challengeOpen(row) {
  if (!row || row.completed_at) return false
  const verifiedAt = row.password_verified_at instanceof Date ? row.password_verified_at : new Date(row.password_verified_at)
  if (Number.isNaN(verifiedAt.getTime())) return false
  return Date.now() - verifiedAt.getTime() <= CHALLENGE_TTL_MINUTES * 60 * 1000
}

export async function issueOtpForChallenge(token) {
  await ensureAnalyticsResetTables()
  const row = await loadChallengeByToken(token)
  if (!row || !challengeOpen(row)) {
    throw new Error('Invalid or expired reset session. Verify password again.')
  }
  if (Number(row.otp_sent_count) >= MAX_OTP_SENDS_PER_CHALLENGE) {
    throw new Error('OTP send limit reached for this session')
  }
  if (row.last_otp_sent_at) {
    const last = row.last_otp_sent_at instanceof Date ? row.last_otp_sent_at : new Date(row.last_otp_sent_at)
    if (Date.now() - last.getTime() < MIN_RESEND_GAP_MS) {
      throw new Error('Please wait before requesting another OTP')
    }
  }

  const otp = generateOtp6()
  const otpHash = hashOtpCode(otp)
  await pool().query(
    `UPDATE analytics_reset_challenges SET
       otp_hash = $2,
       otp_expires_at = now() + ($3::int * interval '1 minute'),
       otp_used = false,
       otp_sent_count = otp_sent_count + 1,
       last_otp_sent_at = now()
     WHERE id = $1::uuid`,
    [row.id, otpHash, OTP_TTL_MINUTES],
  )
  return { otp, challengeId: String(row.id), adminEmail: String(row.admin_email) }
}

export async function verifyOtpAndExecuteReset(token, otpPlain) {
  await ensureAnalyticsResetTables()
  const row = await loadChallengeByToken(token)
  if (!row || !challengeOpen(row)) {
    throw new Error('Invalid or expired reset session')
  }
  if (row.otp_used) {
    throw new Error('OTP already used')
  }
  if (!row.otp_hash || !row.otp_expires_at) {
    throw new Error('OTP not requested yet')
  }

  const attempts = Number(row.otp_verify_attempts) || 0
  if (attempts >= MAX_OTP_VERIFY_ATTEMPTS) {
    throw new Error('Too many OTP attempts')
  }

  const expires =
    row.otp_expires_at instanceof Date ? row.otp_expires_at : new Date(row.otp_expires_at)
  const expired = Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()
  const code = String(otpPlain ?? '').trim()
  const ok = !expired && hashOtpCode(code) === row.otp_hash

  await pool().query(
    `UPDATE analytics_reset_challenges SET
       otp_verify_attempts = otp_verify_attempts + 1,
       last_otp_verify_ok = $2
     WHERE id = $1::uuid`,
    [row.id, ok],
  )

  if (!ok) {
    throw new Error(expired ? 'OTP expired' : 'Invalid OTP')
  }

  await pool().query(
    `UPDATE analytics_reset_challenges SET otp_used = true WHERE id = $1::uuid`,
    [row.id],
  )

  const counts = await clearInstallAnalyticsData(pool())

  await pool().query(
    `UPDATE analytics_reset_challenges SET completed_at = now() WHERE id = $1::uuid`,
    [row.id],
  )

  return {
    challengeId: String(row.id),
    adminEmail: String(row.admin_email),
    ...counts,
  }
}

/** Only install + live session analytics — never billing/security tables. */
export async function clearInstallAnalyticsData(db = pool()) {
  const installs = await db.query(`DELETE FROM app_installs`)
  const sessions = await db.query(`DELETE FROM live_sessions`)
  return {
    installsDeleted: Number(installs.rowCount) || 0,
    sessionsDeleted: Number(sessions.rowCount) || 0,
  }
}
