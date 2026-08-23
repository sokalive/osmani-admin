import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'
import { ensureSecurityVerificationSchema } from '../db/securityVerificationSchema.js'
import { securityChallengeTtlSec } from './securityVerificationConfig.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
    .split(',')[0]
    .trim()
    .slice(0, 64)
}

export async function createSecurityChallenge(deviceId, opts = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureSecurityVerificationSchema(pool)

  const d = text(deviceId, 128)
  if (!d) throw new Error('device_id required')

  const installId = text(opts.install_id ?? opts.installId, 128)
  const ttlSec = securityChallengeTtlSec()
  const nonce = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlSec * 1000)

  const { rows } = await pool.query(
    `INSERT INTO security_verification_challenges (nonce, device_id, install_id, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, nonce, device_id, install_id, created_at, expires_at`,
    [
      nonce,
      d,
      installId,
      expiresAt.toISOString(),
      JSON.stringify({
        issued_ip: opts.ip || '',
        app_version: text(opts.app_version, 64),
      }),
    ],
  )

  const row = rows[0]
  return {
    challenge_id: String(row.id),
    nonce: String(row.nonce),
    device_id: String(row.device_id),
    install_id: String(row.install_id || ''),
    expires_at:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    ttl_sec: ttlSec,
  }
}

/** Consume a challenge nonce. Returns { ok, reason?, challenge? } */
export async function consumeSecurityChallenge({ nonce, deviceId, installId, req }) {
  const pool = getPool()
  if (!pool) return { ok: false, reason: 'database_unavailable' }
  await ensureSecurityVerificationSchema(pool)

  const n = text(nonce, 128)
  const d = text(deviceId, 128)
  if (!n) return { ok: false, reason: 'missing_nonce' }
  if (!d) return { ok: false, reason: 'missing_device_id' }

  const ip = req ? clientIp(req) : ''

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM security_verification_challenges WHERE nonce = $1 FOR UPDATE`,
      [n],
    )
    const ch = rows[0]
    if (!ch) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'unknown_nonce' }
    }

    if (ch.consumed_at) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'nonce_replay', challenge: ch }
    }

    const exp =
      ch.expires_at instanceof Date ? ch.expires_at.getTime() : new Date(ch.expires_at).getTime()
    if (!Number.isFinite(exp) || exp <= Date.now()) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'nonce_expired', challenge: ch }
    }

    if (String(ch.device_id) !== d) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'device_mismatch', challenge: ch }
    }

    const boundInstall = text(ch.install_id, 128)
    const gotInstall = text(installId, 128)
    if (boundInstall && gotInstall && boundInstall !== gotInstall) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'install_mismatch', challenge: ch }
    }

    await client.query(
      `UPDATE security_verification_challenges
       SET consumed_at = now(), consumed_ip = $2
       WHERE nonce = $1`,
      [n, ip],
    )
    await client.query('COMMIT')
    return { ok: true, challenge: ch }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function purgeExpiredChallenges() {
  const pool = getPool()
  if (!pool) return 0
  await ensureSecurityVerificationSchema(pool)
  const out = await pool.query(
    `DELETE FROM security_verification_challenges
     WHERE expires_at < now() - interval '1 day'`,
  )
  return Number(out.rowCount) || 0
}

export { clientIp as securityClientIp }
