/**
 * Durable SonicPesa customer attempt window.
 * One row per device + phone + plan. Postgres clock and row locks are authoritative.
 * Rollback: DROP TABLE sonicpesa_pay_attempt_windows;
 * The table stores hashes and counts only — not payment history or entitlements.
 */
import { getPool } from '../db/pool.js'
import {
  SONICPESA_PAY_ATTEMPT_COOLDOWN_MS,
  decidePayAttemptTransition,
} from './sonicpesaCheckoutPolicy.js'

function mapWindowRow(row) {
  if (!row || row.attempt_count == null) return null
  return {
    attemptCount: Number(row.attempt_count) || 0,
    cooldownUntilMs: row.cooldown_until ? new Date(row.cooldown_until).getTime() : null,
  }
}

function mapDecision(action, row) {
  return {
    action,
    attemptCount: Number(row.attempt_count) || 0,
    cooldownUntilMs: row.cooldown_until ? new Date(row.cooldown_until).getTime() : null,
    serverNowMs: new Date(row.server_now).getTime(),
  }
}

/**
 * Read the window. Does not create a row and does not reset an expired cooldown.
 */
export async function readSonicpesaPayAttempt(identityKey) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  const { rows } = await pool.query(
    `SELECT w.attempt_count, w.cooldown_until, clock_timestamp() AS server_now
     FROM (SELECT clock_timestamp() AS server_now) clk
     LEFT JOIN sonicpesa_pay_attempt_windows w ON w.identity_key = $1`,
    [identityKey],
  )
  const row = rows[0] || {}
  return {
    row: mapWindowRow(row),
    serverNowMs: new Date(row.server_now).getTime(),
  }
}

/**
 * Atomically permit the next attempt or reject it.
 * Concurrent callers serialize on the identity row. A rejection does not
 * increment the count or move cooldown_until.
 */
export async function reserveSonicpesaPayAttempt(identity) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sonicpesa_pay_attempt_windows (
         identity_key, device_id, phone_hash, plan_id, attempt_count, cooldown_until, last_attempt_at, updated_at
       ) VALUES ($1, $2, $3, $4, 0, NULL, NULL, clock_timestamp())
       ON CONFLICT (identity_key) DO NOTHING`,
      [identity.identityKey, identity.deviceId, identity.phoneHash, identity.planId],
    )
    const { rows } = await client.query(
      `SELECT attempt_count, cooldown_until, clock_timestamp() AS server_now
       FROM sonicpesa_pay_attempt_windows
       WHERE identity_key = $1
       FOR UPDATE`,
      [identity.identityKey],
    )
    const locked = rows[0]
    const serverNowMs = new Date(locked.server_now).getTime()
    const decision = decidePayAttemptTransition(
      {
        attemptCount: Number(locked.attempt_count) || 0,
        cooldownUntilMs: locked.cooldown_until ? new Date(locked.cooldown_until).getTime() : null,
      },
      serverNowMs,
    )
    if (decision.action === 'permit') {
      const written = await client.query(
        `UPDATE sonicpesa_pay_attempt_windows
         SET attempt_count = $2,
             cooldown_until = CASE
               WHEN $3::boolean THEN clock_timestamp() + ($4::int * interval '1 millisecond')
               ELSE NULL
             END,
             last_attempt_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE identity_key = $1
         RETURNING attempt_count, cooldown_until, clock_timestamp() AS server_now`,
        [
          identity.identityKey,
          decision.attemptCount,
          decision.cooldownUntilMs != null,
          SONICPESA_PAY_ATTEMPT_COOLDOWN_MS,
        ],
      )
      if (!written.rows[0]) throw new Error('SonicPesa attempt window update missed the locked row')
      await client.query('COMMIT')
      return { ...mapDecision('permit', written.rows[0]), armCooldown: false }
    }
    if (decision.armCooldown) {
      const written = await client.query(
        `UPDATE sonicpesa_pay_attempt_windows
         SET cooldown_until = clock_timestamp() + ($2::int * interval '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE identity_key = $1
           AND cooldown_until IS NULL
         RETURNING attempt_count, cooldown_until, clock_timestamp() AS server_now`,
        [identity.identityKey, SONICPESA_PAY_ATTEMPT_COOLDOWN_MS],
      )
      if (!written.rows[0]) throw new Error('SonicPesa attempt window update missed the locked row')
      await client.query('COMMIT')
      return { ...mapDecision('cooldown', written.rows[0]), armCooldown: true }
    }
    await client.query('COMMIT')
    return {
      action: 'cooldown',
      attemptCount: decision.attemptCount,
      cooldownUntilMs: decision.cooldownUntilMs,
      serverNowMs,
      armCooldown: false,
    }
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* the original error is the one to surface */
    }
    throw e
  } finally {
    client.release()
  }
}
