/**
 * Prevent subscription recovery from re-activating a device that intentionally
 * transferred its package to another device (completed device_transfers row).
 */
import { getPool } from '../db/pool.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

/** Device was the source in any completed transfer (must not auto-recover subscription). */
export async function isCompletedTransferSourceDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const pool = getPool()
  if (!pool) return false
  const { rows } = await pool.query(
    `SELECT 1 FROM device_transfers
     WHERE status = 'completed' AND source_device_id = $1
     LIMIT 1`,
    [d],
  )
  return Boolean(rows[0])
}

/** Old device_id after auto-migration (transaction_id moved:*) — must not receive subscription again. */
export async function isIntentionalMigrationRevokedDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const pool = getPool()
  if (!pool) return false
  const { rows } = await pool.query(
    `SELECT 1 FROM device_subscriptions
     WHERE device_id = $1
       AND COALESCE(transaction_id, '') LIKE 'moved:%'
     LIMIT 1`,
    [d],
  )
  return Boolean(rows[0])
}

/**
 * Block reverse migration: requesting device transferred TO candidateSource;
 * pulling subscription back from candidateSource would undo the transfer.
 */
export async function isReverseTransferMigrationBlocked(requestingDeviceId, candidateSourceDeviceId) {
  const req = String(requestingDeviceId ?? '').trim()
  const src = String(candidateSourceDeviceId ?? '').trim()
  if (!req || !src || req === src) return false
  const pool = getPool()
  if (!pool) return false
  const { rows } = await pool.query(
    `SELECT 1 FROM device_transfers
     WHERE status = 'completed'
       AND source_device_id = $1
       AND target_device_id = $2
     LIMIT 1`,
    [req, src],
  )
  return Boolean(rows[0])
}

/** Filter candidate source devices that must not be used for recovery toward target. */
export async function filterBlockedRecoverySources(targetDeviceId, candidateIds) {
  const target = String(targetDeviceId ?? '').trim()
  const out = []
  for (const id of candidateIds) {
    const c = String(id ?? '').trim()
    if (!c || c === target) continue
    // eslint-disable-next-line no-await-in-loop
    if (await isReverseTransferMigrationBlocked(target, c)) continue
    out.push(c)
  }
  return out
}

/**
 * Audit + optional repair for transfer sources that incorrectly remain active
 * while the transfer target is also active.
 */
export async function auditTransferSourceRevocation({ repair = false } = {}) {
  const pool = requirePool()
  const now = new Date()

  const { rows: transfers24h } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_transfers
     WHERE status = 'completed' AND COALESCE(completed_at, created_at) > now() - interval '24 hours'`,
  )
  const { rows: transfers7d } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_transfers
     WHERE status = 'completed' AND COALESCE(completed_at, created_at) > now() - interval '7 days'`,
  )

  const { rows: badSources } = await pool.query(
    `SELECT dt.id AS transfer_id,
            dt.source_device_id,
            dt.target_device_id,
            dt.completed_at,
            ds_src.status AS source_status,
            ds_src.expires_at AS source_expires_at,
            ds_tgt.status AS target_status,
            ds_tgt.expires_at AS target_expires_at
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds_src ON ds_src.device_id = dt.source_device_id
     INNER JOIN device_subscriptions ds_tgt ON ds_tgt.device_id = dt.target_device_id
     WHERE dt.status = 'completed'
       AND ds_src.status = 'active'
       AND ds_src.expires_at > now()
       AND ds_tgt.status = 'active'
       AND ds_tgt.expires_at > now()
     ORDER BY COALESCE(dt.completed_at, dt.created_at) DESC`,
  )

  const { rows: targetActive } = await pool.query(
    `SELECT COUNT(DISTINCT dt.target_device_id)::int AS n
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds ON ds.device_id = dt.target_device_id
     WHERE dt.status = 'completed'
       AND COALESCE(dt.completed_at, dt.created_at) > now() - interval '7 days'
       AND ds.status = 'active'
       AND ds.expires_at > now()`,
  )

  const { rows: dupActive } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT dt.source_device_id, dt.target_device_id
       FROM device_transfers dt
       INNER JOIN device_subscriptions ds_src ON ds_src.device_id = dt.source_device_id
       INNER JOIN device_subscriptions ds_tgt ON ds_tgt.device_id = dt.target_device_id
       WHERE dt.status = 'completed'
         AND ds_src.status = 'active' AND ds_src.expires_at > now()
         AND ds_tgt.status = 'active' AND ds_tgt.expires_at > now()
     ) x`,
  )

  const { rows: recentTransfers } = await pool.query(
    `SELECT dt.id AS transfer_id,
            dt.source_device_id::text AS source_device_id,
            dt.target_device_id::text AS target_device_id,
            dt.completed_at,
            ds_src.status AS source_status,
            (ds_src.status = 'active' AND ds_src.expires_at > now()) AS source_active_now,
            ds_tgt.status AS target_status,
            (ds_tgt.status = 'active' AND ds_tgt.expires_at > now()) AS target_active_now
     FROM device_transfers dt
     LEFT JOIN device_subscriptions ds_src ON ds_src.device_id = dt.source_device_id
     LEFT JOIN device_subscriptions ds_tgt ON ds_tgt.device_id = dt.target_device_id
     WHERE dt.status = 'completed'
     ORDER BY COALESCE(dt.completed_at, dt.created_at) DESC
     LIMIT 10`,
  )

  let repaired = []
  if (repair && badSources.length) {
    const { notifySubscriptionTransferred } = await import('./subscriptionTransferNotify.js')
    for (const row of badSources) {
      const source = String(row.source_device_id)
      const target = String(row.target_device_id)
      const freedTxnId = `repair:transfer:${row.transfer_id}`.slice(0, 240)
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE device_subscriptions
         SET status = 'pending',
             transaction_id = $2,
             updated_at = now()
         WHERE device_id = $1
           AND status = 'active'
           AND expires_at > now()`,
        [source, freedTxnId],
      )
      // eslint-disable-next-line no-await-in-loop
      const { rows: srcRow } = await pool.query(
        `SELECT device_id, status, expires_at, transaction_id FROM device_subscriptions WHERE device_id = $1`,
        [source],
      )
      // eslint-disable-next-line no-await-in-loop
      const { rows: tgtRow } = await pool.query(
        `SELECT device_id, status, expires_at, transaction_id FROM device_subscriptions WHERE device_id = $1`,
        [target],
      )
      notifySubscriptionTransferred({
        sourceDeviceId: source,
        targetDeviceId: target,
        sourceRow: srcRow[0]
          ? { ...srcRow[0], active_now: false, blocked_now: false }
          : { device_id: source, status: 'pending', active_now: false },
        targetRow: tgtRow[0]
          ? { ...tgtRow[0], active_now: true, blocked_now: false }
          : null,
        reason: 'transfer_repair',
        userInitiatedTransfer: true,
      })
      repaired.push({ source_device_id: source, target_device_id: target, transfer_id: row.transfer_id })
    }
  }

  return {
    audited_at: now.toISOString(),
    transfers_last_24h: transfers24h[0]?.n ?? 0,
    transfers_last_7d: transfers7d[0]?.n ?? 0,
    source_still_active_after_transfer: badSources.length,
    target_active_after_transfer_7d: targetActive[0]?.n ?? 0,
    duplicate_active_pairs: dupActive[0]?.n ?? 0,
    recent_transfers: recentTransfers,
    bad_sources: badSources,
    repaired_count: repaired.length,
    repaired,
    unresolved_count: repair ? 0 : badSources.length,
  }
}
