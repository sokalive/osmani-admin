/**
 * Audit + repair: subscriptions with future expires_at incorrectly denied access
 * (status not active, or wrongly blocked) while entitlement time remains.
 *
 * Never shortens expires_at. Skips completed transfer sources with active targets.
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessStateFast } from '../billingStore.js'
import { reconcileUnblockedPlaybackAccess } from './deviceSecurityPlaybackAudit.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toIso(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** Completed transfer sources that should stay revoked (pending) even if expires_at > now(). */
async function loadLegitimateTransferSourceIds(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT dt.source_device_id::text AS device_id
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds_tgt
       ON ds_tgt.device_id = dt.target_device_id
      AND ds_tgt.status = 'active'
      AND ds_tgt.expires_at > now()
     WHERE dt.status = 'completed'
       AND trim(coalesce(dt.source_device_id::text, '')) <> ''`,
  )
  return new Set(rows.map((r) => String(r.device_id)))
}

/**
 * Rows that should be ACTIVE but are not (future expiry, not a transfer source).
 */
export async function findFalseExpiredSubscriptions(pool = requirePool()) {
  const transferSources = await loadLegitimateTransferSourceIds(pool)
  const { rows: tz } = await pool.query(`SELECT now() AS db_now, current_setting('TIMEZONE') AS tz`)
  const dbNow = tz[0]?.db_now
  const dbTimezone = String(tz[0]?.tz ?? '')

  const { rows } = await pool.query(
    `SELECT
       ds.device_id::text AS device_id,
       ds.status,
       ds.expires_at,
       ds.started_at,
       ds.transaction_id,
       ds.updated_at,
       COALESCE(ds.manual_admin_blocked, false) AS manual_admin_blocked,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       CASE
         WHEN ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ds.expires_at - now())))::bigint)
         ELSE 0::bigint
       END AS remaining_seconds,
       CASE
         WHEN ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 86400.0)::int)
         ELSE 0
       END AS remaining_days
     FROM device_subscriptions ds
     WHERE ds.expires_at > now()
       AND (
         ds.status <> 'active'
         OR COALESCE(ds.manual_admin_blocked, false) = true
       )
       AND COALESCE(ds.transaction_id, '') NOT LIKE 'moved:%'
     ORDER BY ds.expires_at DESC`,
  )

  const affected = []
  const skippedTransferSources = []
  const skippedMovedSources = []
  for (const row of rows) {
    const deviceId = String(row.device_id ?? '')
    const txnId = String(row.transaction_id ?? '')
    if (txnId.startsWith('moved:')) {
      skippedMovedSources.push({
        device_id: deviceId,
        status: row.status,
        expires_at: toIso(row.expires_at),
        transaction_id: txnId,
        reason: 'subscription_moved_to_another_device',
      })
      continue
    }
    if (transferSources.has(deviceId)) {
      skippedTransferSources.push({
        device_id: deviceId,
        status: row.status,
        expires_at: toIso(row.expires_at),
        reason: 'legitimate_transfer_source',
      })
      continue
    }
    affected.push({
      device_id: deviceId,
      status: String(row.status ?? ''),
      expires_at: toIso(row.expires_at),
      started_at: toIso(row.started_at),
      transaction_id: String(row.transaction_id ?? ''),
      manual_admin_blocked: row.manual_admin_blocked === true,
      active_now: row.active_now === true,
      remaining_seconds: Number(row.remaining_seconds) || 0,
      remaining_days: Number(row.remaining_days) || 0,
      category:
        row.manual_admin_blocked === true
          ? 'wrongly_blocked'
          : row.status === 'pending'
            ? 'wrongly_pending'
            : 'wrongly_inactive_status',
    })
  }

  return {
    server_time: dbNow instanceof Date ? dbNow.toISOString() : toIso(dbNow),
    database_timezone: dbTimezone,
    total_future_expiry_rows: rows.length,
    affected_count: affected.length,
    skipped_transfer_source_count: skippedTransferSources.length,
    skipped_moved_source_count: skippedMovedSources.length,
    affected,
    skipped_transfer_sources: skippedTransferSources.slice(0, 25),
    skipped_moved_sources: skippedMovedSources.slice(0, 25),
    root_cause:
      'device_subscriptions.status was not active (often pending after incomplete recovery/transfer) while expires_at remained in the future. Admin maps status!==active to EXPIRED; verify cache zeroes remaining_seconds for non-active rows so the app shows renew. Rows with transaction_id moved:* are intentional post-migration revokes on the old device_id.',
  }
}

async function probeApiActive(deviceId) {
  const row = await getDeviceSubscriptionAccessStateFast(deviceId)
  if (!row) return { active: false, reason: 'no_row' }
  const rem = Number(row.remaining_seconds) || 0
  const active =
    row.blocked_now !== true &&
    String(row.status ?? '').toLowerCase() === 'active' &&
    row.active_now === true
  return {
    active,
    status: row.status,
    active_now: row.active_now === true,
    blocked_now: row.blocked_now === true,
    remaining_seconds: rem,
    expires_at: toIso(row.expires_at),
  }
}

/**
 * @param {{ dryRun?: boolean; confirm?: boolean }} opts
 */
export async function repairFalseExpiredSubscriptions(opts = {}) {
  const dryRun = opts.dryRun !== false
  const confirm = opts.confirm === true
  if (!dryRun && !confirm) {
    return {
      dry_run: true,
      error: 'Live repair requires dryRun=false and confirm=true',
      repaired_count: 0,
    }
  }

  const pool = requirePool()
  const audit = await findFalseExpiredSubscriptions(pool)
  const repaired = []
  const skipped = []

  let reconcileReport = null
  const blockedIds = audit.affected.filter((r) => r.category === 'wrongly_blocked').map((r) => r.device_id)
  if (!dryRun && blockedIds.length > 0) {
    reconcileReport = await reconcileUnblockedPlaybackAccess({ emitUpdates: true })
  }

  for (const row of audit.affected) {
    const deviceId = row.device_id
    const before = { ...row, api: await probeApiActive(deviceId) }

    if (row.category === 'wrongly_blocked') {
      if (!dryRun) {
        await pool.query(
          `UPDATE device_subscriptions
           SET manual_admin_blocked = false, updated_at = now()
           WHERE device_id = $1
             AND expires_at > now()
             AND COALESCE(manual_admin_blocked, false) = true`,
          [deviceId],
        )
        invalidateSubscriptionAccessCache(deviceId)
      }
    } else if (row.status !== 'active') {
      if (!dryRun) {
        await pool.query(
          `UPDATE device_subscriptions
           SET status = 'active', updated_at = now()
           WHERE device_id = $1
             AND expires_at > now()
             AND status <> 'active'
             AND COALESCE(transaction_id, '') NOT LIKE 'moved:%'`,
          [deviceId],
        )
        invalidateSubscriptionAccessCache(deviceId)
      }
    } else {
      skipped.push({ device_id: deviceId, reason: 'unhandled_category', category: row.category })
      continue
    }

    const after = dryRun
      ? { would_set_status: 'active', expires_at_unchanged: before.expires_at }
      : { api: await probeApiActive(deviceId) }

    const ok = dryRun
      ? true
      : after.api?.active === true && after.api?.blocked_now !== true

    repaired.push({
      device_id: deviceId,
      category: row.category,
      before,
      after: dryRun ? { would_set_status: 'active', expires_at_unchanged: before.expires_at } : after,
      ok,
    })
  }

  const postAudit = dryRun ? audit : await findFalseExpiredSubscriptions(pool)

  return {
    dry_run: dryRun,
    root_cause: audit.root_cause,
    database_timezone: audit.database_timezone,
    server_time: audit.server_time,
    affected_count_before: audit.affected_count,
    affected_count_after: postAudit.affected_count,
    repaired_count: dryRun ? audit.affected.length : repaired.filter((r) => r.ok).length,
    repaired,
    skipped,
    reconcile: reconcileReport,
    ok: postAudit.affected_count === 0,
  }
}
