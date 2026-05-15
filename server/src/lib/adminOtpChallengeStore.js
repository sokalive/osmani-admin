import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'
import { hashOtpCode } from './adminFingerprint.js'

export const OTP_PURPOSE_ANALYTICS_RESET = 'analytics_reset'
export const OTP_PURPOSE_ADMIN_SECURITY_GATE = 'admin_security_gate'
export const OTP_PURPOSE_ADMIN_SECURITY_DESTRUCTIVE = 'admin_security_destructive'

export const CHALLENGE_TTL_MINUTES = 15
export const OTP_TTL_MINUTES = 5
export const MAX_OTP_VERIFY_ATTEMPTS = 8
export const MAX_OTP_SENDS_PER_CHALLENGE = 4
export const MIN_RESEND_GAP_MS = 45_000

const TABLE = 'analytics_reset_challenges'

function pool() {
  const p = getPool()
  if (!p) throw new Error('Database not configured')
  return p
}

export function adminAlertEmail() {
  return String(process.env.ADMIN_ALERT_EMAIL ?? '').trim().toLowerCase()
}

export async function ensureAdminOtpChallengeTables(client) {
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
    ALTER TABLE analytics_reset_challenges
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'analytics_reset';
  `)
  await q.query(`
    CREATE INDEX IF NOT EXISTS analytics_reset_challenges_purpose_completed_idx
    ON analytics_reset_challenges (purpose, completed_at DESC)
    WHERE completed_at IS NOT NULL;
  `)
  await q.query(`
    ALTER TABLE analytics_reset_challenges
    ADD COLUMN IF NOT EXISTS action_type TEXT;
  `)
  await q.query(`
    ALTER TABLE analytics_reset_challenges
    ADD COLUMN IF NOT EXISTS action_payload JSONB;
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

export async function logOtpSecurityEvent(db, { actor, eventType, status, detail, metadata = {} }) {
  const p = db || getPool()
  if (!p) return
  await p.query(
    `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [
      String(actor ?? 'Admin').slice(0, 120),
      String(eventType ?? 'OTP challenge').slice(0, 120),
      String(status ?? 'completed').slice(0, 32),
      String(detail ?? '').slice(0, 2000),
      metadata && typeof metadata === 'object' ? metadata : {},
    ],
  )
}

async function loadChallengeByToken(token, purpose) {
  const tokenHash = hashChallengeToken(token)
  const { rows } = await pool().query(
    `SELECT * FROM ${TABLE} WHERE challenge_token_hash = $1 AND purpose = $2 LIMIT 1`,
    [tokenHash, purpose],
  )
  return rows[0] ?? null
}

function challengeOpen(row) {
  if (!row || row.completed_at) return false
  const verifiedAt = row.password_verified_at
  const t = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt)
  if (Number.isNaN(t.getTime())) return false
  return Date.now() - t.getTime() <= CHALLENGE_TTL_MINUTES * 60 * 1000
}

export async function createOtpChallenge(purpose, meta, action = null) {
  await ensureAdminOtpChallengeTables()
  const token = generateChallengeToken()
  const tokenHash = hashChallengeToken(token)
  const actionType = action?.type ? String(action.type).slice(0, 64) : null
  const actionPayload =
    action?.payload && typeof action.payload === 'object' ? action.payload : null
  const { rows } = await pool().query(
    `INSERT INTO ${TABLE} (
       purpose, challenge_token_hash, admin_user_id, admin_email, ip_address, user_agent, device_label,
       password_verified_at, action_type, action_payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9::jsonb)
     RETURNING id`,
    [
      purpose,
      tokenHash,
      String(meta.adminUserId ?? ''),
      String(meta.adminEmail ?? ''),
      String(meta.ip ?? '').slice(0, 80),
      String(meta.userAgent ?? '').slice(0, 400),
      String(meta.deviceLabel ?? '').slice(0, 200),
      actionType,
      actionPayload,
    ],
  )
  return {
    challengeToken: token,
    challengeId: String(rows[0]?.id),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60 * 1000).toISOString(),
  }
}

export async function issueOtpForChallenge(token, purpose) {
  await ensureAdminOtpChallengeTables()
  const row = await loadChallengeByToken(token, purpose)
  if (!row || !challengeOpen(row)) {
    throw new Error('Invalid or expired session. Start verification again.')
  }
  if (Number(row.otp_sent_count) >= MAX_OTP_SENDS_PER_CHALLENGE) {
    throw new Error('OTP send limit reached for this session')
  }
  if (row.last_otp_sent_at) {
    const last = row.last_otp_sent_at instanceof Date ? row.last_otp_sent_at : new Date(row.last_otp_sent_at)
    const waitSec = Math.ceil((MIN_RESEND_GAP_MS - (Date.now() - last.getTime())) / 1000)
    if (Date.now() - last.getTime() < MIN_RESEND_GAP_MS) {
      throw new Error(`Please wait ${Math.max(1, waitSec)}s before resending OTP`)
    }
  }

  const otp = generateOtp6()
  const otpHash = hashOtpCode(otp)
  await pool().query(
    `UPDATE ${TABLE} SET
       otp_hash = $2,
       otp_expires_at = now() + ($3::int * interval '1 minute'),
       otp_used = false,
       otp_sent_count = otp_sent_count + 1,
       last_otp_sent_at = now()
     WHERE id = $1::uuid`,
    [row.id, otpHash, OTP_TTL_MINUTES],
  )
  return {
    otp,
    challengeId: String(row.id),
    adminEmail: String(row.admin_email),
    resendAvailableAt: new Date(Date.now() + MIN_RESEND_GAP_MS).toISOString(),
  }
}

export async function verifyOtpForChallenge(token, otpPlain, purpose) {
  await ensureAdminOtpChallengeTables()
  const row = await loadChallengeByToken(token, purpose)
  if (!row || !challengeOpen(row)) {
    throw new Error('Invalid or expired session')
  }
  if (row.otp_used) {
    throw new Error('OTP already used')
  }
  if (!row.otp_hash || !row.otp_expires_at) {
    throw new Error('OTP not sent yet')
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
    `UPDATE ${TABLE} SET
       otp_verify_attempts = otp_verify_attempts + 1,
       last_otp_verify_ok = $2
     WHERE id = $1::uuid`,
    [row.id, ok],
  )

  if (!ok) {
    throw new Error(expired ? 'OTP expired' : 'Invalid OTP')
  }

  await pool().query(
    `UPDATE ${TABLE} SET otp_used = true, completed_at = now() WHERE id = $1::uuid`,
    [row.id],
  )

  return {
    challengeId: String(row.id),
    adminEmail: String(row.admin_email),
    adminUserId: String(row.admin_user_id),
    actionType: row.action_type ? String(row.action_type) : null,
    actionPayload:
      row.action_payload && typeof row.action_payload === 'object' ? row.action_payload : null,
  }
}

export async function getLastCompletedChallengeAt(purpose) {
  await ensureAdminOtpChallengeTables()
  const { rows } = await pool().query(
    `SELECT completed_at FROM ${TABLE}
     WHERE purpose = $1 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [purpose],
  )
  const t = rows[0]?.completed_at
  return t instanceof Date ? t : t ? new Date(t) : null
}
