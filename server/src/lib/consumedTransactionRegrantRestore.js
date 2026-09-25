/**
 * Read-only classification + optional restore of proven same-transaction
 * post-expiry re-grants.
 *
 * Proven signature (category A only):
 * - subscription.transaction_id is the completed payment order
 * - authoritative first completion is orderStatusPolledAt, webhookAt, or completed_at
 *   (created_at alone is never enough — that is a delayed first activation)
 * - started_at is AFTER the midnight-EAT window implied by that first completion
 * - current expires_at matches a fresh window from the later started_at
 *
 * Restore sets started_at/expires_at back to that first window. If that window
 * has already ended, the device stays inactive. The transaction row is kept.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/pool.js'
import { computeMidnightEatExpiryIso } from './subscriptionStacking.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

const MS_TOLERANCE = 2 * 60 * 1000

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null || v === '') return null
  const n = new Date(v).getTime()
  return Number.isFinite(n) ? n : null
}

function iso(v) {
  const ms = toMs(v)
  return ms == null ? null : new Date(ms).toISOString()
}

function text(v) {
  return String(v ?? '').trim()
}

function maskId(id) {
  const s = text(id)
  if (s.length <= 10) return s ? `${s.slice(0, 4)}…` : null
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function firstCompletionMs(row) {
  return (
    toMs(row.order_status_polled_at) ??
    toMs(row.webhook_at) ??
    toMs(row.completed_at)
  )
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS consumed_transaction_regrant_backups (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      old_row JSONB NOT NULL,
      evidence JSONB NOT NULL,
      old_started_at TIMESTAMPTZ,
      old_expires_at TIMESTAMPTZ,
      restored_started_at TIMESTAMPTZ NOT NULL,
      restored_expires_at TIMESTAMPTZ NOT NULL,
      plan_duration_days INT,
      repair_reason TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT 'consumed_transaction_regrant_restore',
      UNIQUE (batch_id, device_id)
    )
  `)
}

export async function auditConsumedTransactionRegrants({ deviceId = null, limit = 500 } = {}) {
  const pool = requirePool()
  const params = []
  let deviceClause = ''
  if (deviceId) {
    params.push(text(deviceId))
    deviceClause = `AND ds.device_id = $${params.length}`
  }
  params.push(Math.min(2000, Math.max(1, Number(limit) || 500)))
  const { rows } = await pool.query(
    `SELECT
       ds.device_id::text AS device_id,
       ds.status,
       ds.started_at,
       ds.expires_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       t.order_id,
       t.status AS txn_status,
       t.amount,
       t.created_at AS txn_created_at,
       t.completed_at,
       t.updated_at AS txn_updated_at,
       t.plan_duration_days,
       NULLIF(trim(t.raw_payload->>'orderStatusPolledAt'), '') AS order_status_polled_at,
       NULLIF(trim(t.raw_payload->>'webhookAt'), '') AS webhook_at,
       t.raw_payload->'activation_result'->>'activation_state' AS activation_state,
       p.name AS plan_name,
       p.duration_days AS live_duration_days
     FROM device_subscriptions ds
     INNER JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.status = 'completed'
       AND ds.admin_revoked_at IS NULL
       AND ds.started_at IS NOT NULL
       AND COALESCE(ds.transaction_id, '') !~* '^(moved|transfer|recovery|force|repair|manual_grant|admin_manual):'
       AND (
         NULLIF(trim(t.raw_payload->>'orderStatusPolledAt'), '') IS NOT NULL
         OR NULLIF(trim(t.raw_payload->>'webhookAt'), '') IS NOT NULL
         OR t.completed_at IS NOT NULL
       )
       ${deviceClause}
     ORDER BY ds.started_at DESC
     LIMIT $${params.length}`,
    params,
  )

  const proven = []
  const legitimateLate = []
  const inconclusive = []

  for (const row of rows) {
    const snap = Math.trunc(Number(row.plan_duration_days))
    const live = Math.trunc(Number(row.live_duration_days))
    const duration = Number.isFinite(snap) && snap >= 1 ? snap : Number.isFinite(live) && live >= 1 ? live : null
    const creditMs = firstCompletionMs(row)
    const startedMs = toMs(row.started_at)
    const expiresMs = toMs(row.expires_at)
    if (!duration || creditMs == null || startedMs == null) {
      inconclusive.push({
        device_id_masked: maskId(row.device_id),
        order_id_redacted: maskId(row.order_id),
        reason: 'missing_duration_or_clock',
      })
      continue
    }
    const originalExpires = computeMidnightEatExpiryIso(duration, creditMs)
    const originalExpiresMs = toMs(originalExpires)
    const rewrittenExpires = computeMidnightEatExpiryIso(duration, startedMs)
    const base = {
      device_id: text(row.device_id),
      device_id_masked: maskId(row.device_id),
      order_id: text(row.order_id),
      order_id_redacted: maskId(row.order_id),
      plan_name: row.plan_name ?? null,
      amount: row.amount != null ? Number(row.amount) : null,
      plan_duration_days: duration,
      credit_at: iso(creditMs),
      original_expires_at: originalExpires,
      started_at: iso(row.started_at),
      expires_at: iso(row.expires_at),
      activation_state: row.activation_state ?? null,
      status: text(row.status),
    }
    if (originalExpiresMs == null) {
      inconclusive.push({ ...base, reason: 'bad_original_expiry' })
      continue
    }
    if (startedMs <= originalExpiresMs + MS_TOLERANCE) {
      legitimateLate.push({ ...base, classification: 'LEGITIMATE_SINGLE_WINDOW' })
      continue
    }
    const matchesSecondWindow =
      expiresMs != null && Math.abs(expiresMs - toMs(rewrittenExpires)) <= MS_TOLERANCE
    if (!matchesSecondWindow) {
      inconclusive.push({ ...base, classification: 'INCONCLUSIVE', reason: 'expires_not_a_fresh_window_from_later_started_at' })
      continue
    }
    proven.push({
      ...base,
      classification: 'PROVEN_POST_EXPIRY_REGRANT',
      restored_started_at: iso(creditMs),
      restored_expires_at: originalExpires,
      original_window_already_ended: originalExpiresMs <= Date.now(),
      repair_reason: 'same_transaction_reactivated_after_original_window',
    })
  }

  return {
    audited_at: new Date().toISOString(),
    reviewed: rows.length,
    proven_count: proven.length,
    legitimate_late_count: legitimateLate.length,
    inconclusive_count: inconclusive.length,
    proven,
    legitimate_late_sample: legitimateLate.slice(0, 20),
    inconclusive_sample: inconclusive.slice(0, 30),
  }
}

export async function applyConsumedTransactionRegrantRestore({
  dryRun = true,
  confirm = false,
  appliedBy = 'consumed_transaction_regrant_restore',
  deviceId = null,
  maxRepairs = 50,
} = {}) {
  const audit = await auditConsumedTransactionRegrants({
    deviceId,
    limit: Math.min(2000, Math.max(1, Number(maxRepairs) || 50)),
  })
  const victims = audit.proven.slice(0, Math.min(50, Math.max(1, Number(maxRepairs) || 50)))

  if (dryRun || !confirm) {
    return {
      ok: true,
      dry_run: true,
      applied: false,
      batch_id: null,
      reviewed: audit.reviewed,
      proven_count: audit.proven_count,
      legitimate_late_count: audit.legitimate_late_count,
      inconclusive_count: audit.inconclusive_count,
      would_repair: victims.length,
      repairs: victims,
      legitimate_late_sample: audit.legitimate_late_sample,
      inconclusive_sample: audit.inconclusive_sample,
    }
  }

  if (victims.length > 25) {
    return {
      ok: false,
      applied: false,
      dry_run: false,
      error: 'refusing_broad_repair',
      proven_count: victims.length,
      message: 'More than 25 proven re-grants. Review before apply.',
    }
  }

  const pool = requirePool()
  const client = await pool.connect()
  const batchId = randomUUID()
  const applied = []
  const skipped = []

  try {
    await client.query('BEGIN')
    await ensureBackupTable(client)
    for (const row of victims) {
      const locked = await client.query(
        `SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
        [row.device_id],
      )
      const current = locked.rows[0]
      if (!current) {
        skipped.push({ device_id_masked: row.device_id_masked, reason: 'row_missing' })
        continue
      }
      if (text(current.transaction_id) !== row.order_id) {
        skipped.push({ device_id_masked: row.device_id_masked, reason: 'transaction_changed' })
        continue
      }
      if (iso(current.started_at) !== row.started_at || iso(current.expires_at) !== row.expires_at) {
        skipped.push({ device_id_masked: row.device_id_masked, reason: 'concurrent_change' })
        continue
      }
      const restoredStartMs = toMs(row.restored_started_at)
      const restoredExpMs = toMs(row.restored_expires_at)
      if (restoredStartMs == null || restoredExpMs == null || restoredExpMs <= restoredStartMs) {
        skipped.push({ device_id_masked: row.device_id_masked, reason: 'invalid_restore_window' })
        continue
      }

      await client.query(
        `INSERT INTO consumed_transaction_regrant_backups
           (batch_id, device_id, order_id, old_row, evidence, old_started_at, old_expires_at,
            restored_started_at, restored_expires_at, plan_duration_days, repair_reason, applied_by)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz,
                 $8::timestamptz, $9::timestamptz, $10, $11, $12)`,
        [
          batchId,
          row.device_id,
          row.order_id,
          JSON.stringify(current),
          JSON.stringify(row),
          row.started_at,
          row.expires_at,
          row.restored_started_at,
          row.restored_expires_at,
          row.plan_duration_days,
          row.repair_reason,
          text(appliedBy).slice(0, 200),
        ],
      )

      const updated = await client.query(
        `UPDATE device_subscriptions
         SET started_at = $2::timestamptz,
             expires_at = $3::timestamptz,
             updated_at = now()
         WHERE device_id = $1
           AND transaction_id = $4
           AND started_at = $5::timestamptz
           AND expires_at = $6::timestamptz
           AND admin_revoked_at IS NULL
         RETURNING device_id, status, started_at, expires_at, transaction_id`,
        [
          row.device_id,
          row.restored_started_at,
          row.restored_expires_at,
          row.order_id,
          row.started_at,
          row.expires_at,
        ],
      )
      if (!updated.rows[0]) {
        skipped.push({ device_id_masked: row.device_id_masked, reason: 'update_missed' })
        continue
      }

      await client.query(
        `UPDATE transactions
         SET raw_payload = jsonb_set(
           COALESCE(raw_payload, '{}'::jsonb),
           '{entitlement_consumed_at}',
           to_jsonb($2::text),
           true
         )
         WHERE order_id = $1
           AND NULLIF(trim(COALESCE(raw_payload->>'entitlement_consumed_at', '')), '') IS NULL`,
        [row.order_id, row.restored_started_at],
      )

      applied.push({
        device_id_masked: row.device_id_masked,
        order_id_redacted: row.order_id_redacted,
        restored_started_at: row.restored_started_at,
        restored_expires_at: row.restored_expires_at,
        removed_expires_at: row.expires_at,
        original_window_already_ended: row.original_window_already_ended,
      })
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  for (const row of victims) {
    if (!applied.some((a) => a.device_id_masked === row.device_id_masked)) continue
    try {
      invalidateSubscriptionAccessCache(row.device_id)
      clearVerifyAccessInflightForDevice(row.device_id)
      deviceSubscriptionBus.publish(row.device_id, { reason: 'consumed_transaction_regrant_restored' })
    } catch {
      /* best-effort cache invalidation */
    }
  }

  return {
    ok: true,
    dry_run: false,
    applied: true,
    batch_id: batchId,
    backup_table: 'consumed_transaction_regrant_backups',
    reviewed: audit.reviewed,
    proven_count: audit.proven_count,
    repaired: applied.length,
    skipped: skipped.length,
    repairs: applied,
    skipped_rows: skipped,
    legitimate_late_count: audit.legitimate_late_count,
    inconclusive_count: audit.inconclusive_count,
  }
}
