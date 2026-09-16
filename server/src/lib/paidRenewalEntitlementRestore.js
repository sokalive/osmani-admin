/**
 * Restore entitlements destroyed by the paid-renewal-after-expiry credit-clock bug.
 *
 * Proven signature:
 *   activation_result = ACTIVATED
 *   + expires_at < started_at
 *   + completed payment linked by transaction_id
 *   + plan_duration_days available
 *
 * Restores expires_at = midnight_EAT(started_at) + plan_duration_days (no stack).
 * Also backfills transactions.completed_at when null.
 *
 * Dry-run by default. Never adds free time beyond purchased duration.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/pool.js'
import { computeMidnightEatExpiryIso } from './subscriptionStacking.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { resolveTransactionCreditAtMs } from './transactionCreditClock.js'

const MS_TOLERANCE = 2 * 60 * 1000

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
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
  if (!s) return null
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function isSpecialTxn(txnId) {
  const t = text(txnId).toLowerCase()
  return (
    t.startsWith('moved:') ||
    t.startsWith('transfer:') ||
    t.startsWith('recovery:') ||
    t.startsWith('force:') ||
    t.startsWith('repair:') ||
    t.startsWith('manual_grant:') ||
    t.startsWith('admin_manual:')
  )
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS paid_renewal_entitlement_restore_backups (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      order_id TEXT,
      old_row JSONB NOT NULL,
      evidence JSONB NOT NULL,
      old_expires_at TIMESTAMPTZ,
      new_expires_at TIMESTAMPTZ NOT NULL,
      old_started_at TIMESTAMPTZ,
      plan_duration_days INT,
      repair_reason TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT 'paid_renewal_entitlement_restore',
      UNIQUE (batch_id, device_id)
    )
  `)
  await client.query(
    `CREATE INDEX IF NOT EXISTS paid_renewal_entitlement_restore_backups_device_idx
     ON paid_renewal_entitlement_restore_backups (device_id, applied_at DESC)`,
  )
}

/**
 * Find proven victims: activated payment whose expires_at was rewritten before started_at.
 */
export async function auditPaidRenewalEntitlementVictims({ deviceId = null, limit = 500 } = {}) {
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
       ds.status AS sub_status,
       ds.started_at,
       ds.expires_at,
       ds.updated_at AS sub_updated_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       t.order_id,
       t.status AS txn_status,
       t.created_at AS txn_created_at,
       t.completed_at AS txn_completed_at,
       t.updated_at AS txn_updated_at,
       t.plan_id,
       t.plan_duration_days,
       t.raw_payload,
       p.duration_days AS live_plan_duration_days,
       p.name AS plan_name
     FROM device_subscriptions ds
     INNER JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE ds.admin_revoked_at IS NULL
       AND ds.started_at IS NOT NULL
       AND ds.expires_at IS NOT NULL
       AND ds.expires_at < ds.started_at - interval '2 minutes'
       AND t.status = 'completed'
       AND COALESCE(ds.transaction_id, '') !~* '^(moved|transfer|recovery|force|repair|manual_grant|admin_manual):'
       AND COALESCE(t.raw_payload->'activation_result'->>'activation_state', '') IN ('ACTIVATED', 'ALREADY_APPLIED')
       AND COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) IS NOT NULL
       ${deviceClause}
     ORDER BY ds.started_at DESC
     LIMIT $${params.length}`,
    params,
  )

  const candidates = []
  const rejected = []

  for (const row of rows) {
    const startMs = toMs(row.started_at)
    const oldExpMs = toMs(row.expires_at)
    const snap = Math.trunc(Number(row.plan_duration_days))
    const live = Math.trunc(Number(row.live_plan_duration_days))
    const durationDays =
      Number.isFinite(snap) && snap >= 1 ? snap : Number.isFinite(live) && live >= 1 ? live : null

    if (!startMs || !durationDays) {
      rejected.push({
        device_id_masked: maskId(row.device_id),
        reason: 'insufficient_duration_or_started_at',
      })
      continue
    }

    const creditMs = resolveTransactionCreditAtMs({
      completed_at: row.txn_completed_at,
      created_at: row.txn_created_at,
      updated_at: row.txn_updated_at,
      status: row.txn_status,
      raw_payload: row.raw_payload,
    })
    // Authoritative activation clock for this entitlement is started_at (proven activation).
    const anchorMs = Math.max(startMs, creditMs ?? 0)
    const canonicalExpiresAt = computeMidnightEatExpiryIso(durationDays, anchorMs)
    const canonicalMs = toMs(canonicalExpiresAt)

    if (canonicalMs == null || canonicalMs <= startMs - MS_TOLERANCE) {
      rejected.push({
        device_id_masked: maskId(row.device_id),
        reason: 'canonical_not_after_started_at',
        canonical_expires_at: canonicalExpiresAt,
      })
      continue
    }

    if (oldExpMs != null && Math.abs(oldExpMs - canonicalMs) <= MS_TOLERANCE) {
      rejected.push({
        device_id_masked: maskId(row.device_id),
        reason: 'already_canonical',
      })
      continue
    }

    // Only restore forward — never shorten further.
    if (oldExpMs != null && canonicalMs <= oldExpMs + MS_TOLERANCE) {
      rejected.push({
        device_id_masked: maskId(row.device_id),
        reason: 'canonical_not_greater_than_current',
        old_expires_at: iso(row.expires_at),
        canonical_expires_at: canonicalExpiresAt,
      })
      continue
    }

    const createdMs = toMs(row.txn_created_at)
    const rewrittenFromCreated =
      createdMs != null &&
      oldExpMs != null &&
      Math.abs(oldExpMs - toMs(computeMidnightEatExpiryIso(durationDays, createdMs))) <= MS_TOLERANCE

    candidates.push({
      device_id: text(row.device_id),
      device_id_masked: maskId(row.device_id),
      order_id: text(row.order_id),
      order_id_redacted: maskId(row.order_id),
      sub_status: text(row.sub_status),
      started_at: iso(row.started_at),
      old_expires_at: iso(row.expires_at),
      canonical_expires_at: canonicalExpiresAt,
      plan_duration_days: durationDays,
      plan_name: row.plan_name ?? null,
      txn_created_at: iso(row.txn_created_at),
      txn_completed_at: iso(row.txn_completed_at),
      txn_updated_at: iso(row.txn_updated_at),
      activation_state: row.raw_payload?.activation_result?.activation_state ?? null,
      credit_at: creditMs != null ? new Date(creditMs).toISOString() : null,
      rewritten_from_created_at: rewrittenFromCreated === true,
      repair_reason: 'paid_renewal_expires_before_started_after_bad_correction',
      needs_completed_at_backfill: row.txn_completed_at == null,
    })
  }

  return {
    audited_at: new Date().toISOString(),
    signature:
      'expires_at < started_at AND activation ACTIVATED/ALREADY_APPLIED AND completed payment linked',
    candidates_count: candidates.length,
    rejected_count: rejected.length,
    candidates,
    rejected: rejected.slice(0, 50),
  }
}

/**
 * Apply evidence-backed restores. Dry-run default.
 */
export async function applyPaidRenewalEntitlementRestore({
  dryRun = true,
  confirm = false,
  appliedBy = 'paid_renewal_entitlement_restore',
  deviceId = null,
  maxRepairs = 500,
} = {}) {
  const audit = await auditPaidRenewalEntitlementVictims({
    deviceId,
    limit: Math.min(2000, Math.max(1, Number(maxRepairs) || 500)),
  })
  const candidates = audit.candidates.slice(0, Math.min(500, Math.max(1, Number(maxRepairs) || 500)))

  if (dryRun || !confirm) {
    return {
      ok: true,
      dry_run: true,
      applied: false,
      batch_id: null,
      candidates_count: audit.candidates_count,
      rejected_count: audit.rejected_count,
      would_repair: candidates.length,
      repairs: candidates,
      rejected_sample: audit.rejected,
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

    for (const row of candidates) {
      const d = row.device_id
      const locked = await client.query(
        `SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
        [d],
      )
      const current = locked.rows[0]
      if (!current) {
        skipped.push({ device_id: maskId(d), reason: 'row_missing' })
        continue
      }
      if (current.admin_revoked_at != null) {
        skipped.push({ device_id: maskId(d), reason: 'revoked' })
        continue
      }
      if (iso(current.expires_at) !== row.old_expires_at) {
        skipped.push({
          device_id: maskId(d),
          reason: 'concurrent_change',
          now: iso(current.expires_at),
        })
        continue
      }
      if (iso(current.started_at) !== row.started_at) {
        skipped.push({ device_id: maskId(d), reason: 'started_at_changed' })
        continue
      }

      const targetIso = row.canonical_expires_at
      const targetMs = toMs(targetIso)
      const startMs = toMs(current.started_at)
      if (startMs == null || targetMs == null || targetMs < startMs - MS_TOLERANCE) {
        skipped.push({ device_id: maskId(d), reason: 'guard_expires_before_started' })
        continue
      }

      await client.query(
        `INSERT INTO paid_renewal_entitlement_restore_backups
           (batch_id, device_id, order_id, old_row, evidence, old_expires_at, new_expires_at,
            old_started_at, plan_duration_days, repair_reason, applied_by)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz,
                 $8::timestamptz, $9, $10, $11)`,
        [
          batchId,
          d,
          row.order_id,
          JSON.stringify(current),
          JSON.stringify(row),
          row.old_expires_at,
          targetIso,
          row.started_at,
          row.plan_duration_days,
          row.repair_reason,
          text(appliedBy),
        ],
      )

      const updated = await client.query(
        `UPDATE device_subscriptions
         SET expires_at = $2::timestamptz,
             status = 'active',
             updated_at = now()
         WHERE device_id = $1
           AND expires_at = $3::timestamptz
           AND admin_revoked_at IS NULL
         RETURNING device_id, status, expires_at, started_at, transaction_id`,
        [d, targetIso, row.old_expires_at],
      )
      if (!updated.rows[0]) {
        skipped.push({ device_id: maskId(d), reason: 'update_missed' })
        continue
      }

      if (row.needs_completed_at_backfill && row.order_id) {
        await client.query(
          `UPDATE transactions
           SET completed_at = COALESCE(completed_at, $2::timestamptz, updated_at, now())
           WHERE order_id = $1 AND status = 'completed' AND completed_at IS NULL`,
          [row.order_id, row.started_at],
        )
      }

      applied.push({
        device_id_masked: maskId(d),
        order_id_redacted: maskId(row.order_id),
        old_expires_at: row.old_expires_at,
        new_expires_at: targetIso,
        plan_duration_days: row.plan_duration_days,
        started_at: row.started_at,
      })
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  for (const row of applied) {
    // Invalidate using full device id from candidates
    const full = candidates.find((c) => maskId(c.device_id) === row.device_id_masked)
    const d = full?.device_id
    if (!d) continue
    try {
      invalidateSubscriptionAccessCache(d)
      clearVerifyAccessInflightForDevice(d)
      deviceSubscriptionBus.publish(d, {
        reason: 'paid_renewal_entitlement_restored',
        expires_at: row.new_expires_at,
      })
    } catch {
      /* best-effort */
    }
  }

  return {
    ok: true,
    dry_run: false,
    applied: true,
    batch_id: batchId,
    backup_table: 'paid_renewal_entitlement_restore_backups',
    candidates_count: audit.candidates_count,
    rejected_count: audit.rejected_count,
    repaired: applied.length,
    skipped: skipped.length,
    repairs: applied,
    skipped_rows: skipped,
  }
}
