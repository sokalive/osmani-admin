/**
 * Manual gift popup audit + safe acknowledgement repair (manual_subscription_grants only).
 * Does not modify device_subscriptions expiry, payment rows, or transfers.
 */
import { getPool } from '../db/pool.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

const MANUAL_GRANT_TXN_RE = '^manual_grant:[0-9]+$'
/** Approximate deploy time of strict getOldestPendingManualGrant (e9b92ff). */
const MANUAL_GIFT_STRICT_FIX_AT = '2026-07-03T20:49:00.000Z'

const TESTING_DEVICE_SQL = `(
  g.device_id ~ '^verify[_-]'
  OR lower(g.device_id) IN ('x', 'test', 'probe')
  OR g.device_id ~ '^test[_-]'
  OR g.device_id ~ '^probe[_-]'
)`

/** Unacknowledged grants that would wrongly trigger popup under legacy lookup. */
export async function findStalePendingManualGiftGrants({ limit = 500 } = {}) {
  const pool = requirePool()
  const lim = Math.min(5000, Math.max(1, Number(limit) || 500))
  const { rows } = await pool.query(
    `SELECT
       g.id AS grant_id,
       g.device_id,
       g.duration_days,
       g.created_at AS granted_at,
       g.acknowledged_at,
       g.deleted_at,
       ds.status AS sub_status,
       ds.expires_at AS sub_expires_at,
       ds.transaction_id AS sub_transaction_id,
       COALESCE(ds.manual_admin_blocked, false) AS manual_admin_blocked,
       CASE
         WHEN ds.device_id IS NULL THEN 'no_subscription_row'
         WHEN ds.expires_at <= now() OR lower(COALESCE(ds.status, '')) <> 'active' THEN 'subscription_inactive'
         WHEN COALESCE(ds.manual_admin_blocked, false) THEN 'manual_admin_blocked'
         WHEN COALESCE(ds.transaction_id, '') !~ $2 THEN 'non_manual_transaction'
         WHEN g.id > (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint) THEN 'superseded_manual_grant'
         ELSE 'eligible'
       END AS stale_reason
     FROM manual_subscription_grants g
     LEFT JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.acknowledged_at IS NULL
       AND g.deleted_at IS NULL
       AND (
         ds.device_id IS NULL
         OR ds.expires_at <= now()
         OR lower(COALESCE(ds.status, '')) <> 'active'
         OR COALESCE(ds.manual_admin_blocked, false)
         OR COALESCE(ds.transaction_id, '') !~ $2
         OR g.id > (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)
       )
     ORDER BY g.created_at ASC
     LIMIT $1`,
    [lim, MANUAL_GRANT_TXN_RE],
  )
  return rows
}

/** Count buckets for SQL evidence report. */
export async function countManualGiftAuditStats() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `WITH pending AS (
       SELECT g.id, g.device_id
       FROM manual_subscription_grants g
       WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
     ),
     legacy_popup AS (
       SELECT p.id FROM pending p
     ),
     strict_popup AS (
       SELECT g.id
       FROM manual_subscription_grants g
       INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
       WHERE g.acknowledged_at IS NULL
         AND g.deleted_at IS NULL
         AND ds.status = 'active'
         AND ds.expires_at > now()
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND ds.transaction_id ~ $1
         AND g.id <= (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)
     ),
     stale AS (
       SELECT p.id, p.device_id FROM pending p
       WHERE p.id NOT IN (SELECT id FROM strict_popup)
     )
     SELECT
       (SELECT COUNT(*)::int FROM pending) AS pending_unacked_total,
       (SELECT COUNT(*)::int FROM legacy_popup) AS legacy_would_popup,
       (SELECT COUNT(*)::int FROM strict_popup) AS strict_legitimate_popup,
       (SELECT COUNT(*)::int FROM stale) AS stale_false_positive_grants,
       (SELECT COUNT(DISTINCT device_id)::int FROM stale) AS stale_false_positive_devices`,
    [MANUAL_GRANT_TXN_RE],
  )
  return rows[0] ?? {}
}

/**
 * Safely acknowledge stale pending grants (metadata only — no subscription mutation).
 * Returns { repaired, sample }.
 */
export async function repairStaleManualGiftAcknowledgements({ dryRun = false, limit = 5000 } = {}) {
  const pool = requirePool()
  const lim = Math.min(10000, Math.max(1, Number(limit) || 5000))
  const stale = await findStalePendingManualGiftGrants({ limit: lim })
  if (dryRun || stale.length === 0) {
    return { dryRun: Boolean(dryRun), repaired: 0, staleCount: stale.length, sample: stale.slice(0, 24) }
  }

  const ids = stale.map((r) => Number(r.grant_id)).filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) {
    return { dryRun: false, repaired: 0, staleCount: 0, sample: [] }
  }

  const { rowCount } = await pool.query(
    `UPDATE manual_subscription_grants
     SET acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = ANY($1::bigint[])
       AND acknowledged_at IS NULL
       AND deleted_at IS NULL`,
    [ids],
  )
  return {
    dryRun: false,
    repaired: Number(rowCount) || 0,
    staleCount: stale.length,
    sample: stale.slice(0, 24),
  }
}

/** Acknowledge obsolete testing grants only (grants table — no subscription mutation). */
export async function repairObsoleteTestingManualGrants({ dryRun = false, limit = 5000 } = {}) {
  const pool = requirePool()
  const lim = Math.min(10000, Math.max(1, Number(limit) || 5000))
  const { rows } = await pool.query(
    `SELECT g.id AS grant_id, g.device_id, g.created_at AS granted_at
     FROM manual_subscription_grants g
     WHERE g.deleted_at IS NULL
       AND g.acknowledged_at IS NULL
       AND ${TESTING_DEVICE_SQL}
     ORDER BY g.created_at ASC
     LIMIT $1`,
    [lim],
  )
  if (dryRun || rows.length === 0) {
    return { dryRun: Boolean(dryRun), repaired: 0, testingPendingCount: rows.length, sample: rows.slice(0, 24) }
  }
  const ids = rows.map((r) => Number(r.grant_id)).filter((id) => Number.isFinite(id) && id > 0)
  const { rowCount } = await pool.query(
    `UPDATE manual_subscription_grants
     SET acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = ANY($1::bigint[])
       AND acknowledged_at IS NULL
       AND deleted_at IS NULL`,
    [ids],
  )
  return {
    dryRun: false,
    repaired: Number(rowCount) || 0,
    testingPendingCount: rows.length,
    sample: rows.slice(0, 24),
  }
}

export async function runManualGiftDatabaseReport() {
  const stats = await countManualGiftAuditStats()
  const staleSample = await findStalePendingManualGiftGrants({ limit: 40 })
  const byReason = {}
  for (const row of staleSample) {
    const r = String(row.stale_reason ?? 'unknown')
    byReason[r] = (byReason[r] || 0) + 1
  }
  return {
    generated_at: new Date().toISOString(),
    stats,
    stale_reason_sample_counts: byReason,
    stale_sample: staleSample.slice(0, 24),
  }
}

/** Full read-only production PostgreSQL investigation for manual gift popup eligibility. */
export async function runManualGiftProductionInvestigation() {
  const pool = requirePool()

  const { rows: grantCounts } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged,
       COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND deleted_at IS NULL)::int AS unacknowledged,
       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
       COUNT(*) FILTER (
         WHERE deleted_at IS NULL
           AND expires_at_snapshot IS NOT NULL
           AND expires_at_snapshot <= now()
       )::int AS expired_by_snapshot,
       COUNT(*) FILTER (
         WHERE deleted_at IS NULL
           AND acknowledged_at IS NULL
           AND EXISTS (
             SELECT 1 FROM device_subscriptions ds
             WHERE ds.device_id = manual_subscription_grants.device_id
               AND ds.status = 'active'
               AND ds.expires_at > now()
               AND ds.transaction_id ~ $1
           )
       )::int AS active_unacked_with_manual_sub
     FROM manual_subscription_grants`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: testPending } = await pool.query(
    `SELECT g.id, g.device_id, g.duration_days, g.created_at, g.acknowledged_at, g.deleted_at,
            ds.status AS sub_status, ds.expires_at, ds.transaction_id
     FROM manual_subscription_grants g
     LEFT JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.deleted_at IS NULL
       AND g.acknowledged_at IS NULL
       AND (
         g.device_id ~ '^verify[_-]'
         OR lower(g.device_id) IN ('x', 'test', 'probe')
         OR g.device_id ~ '^test[_-]'
         OR g.device_id ~ '^probe[_-]'
       )
     ORDER BY g.created_at ASC`,
  )

  const { rows: popupDevices } = await pool.query(
    `WITH strict_pending AS (
       SELECT
         g.device_id,
         g.id AS grant_id,
         g.duration_days,
         g.created_at AS granted_at,
         g.acknowledged_at,
         g.deleted_at,
         ds.status AS sub_status,
         ds.expires_at AS sub_expires_at,
         ds.transaction_id AS sub_transaction_id,
         ROW_NUMBER() OVER (PARTITION BY g.device_id ORDER BY g.created_at ASC) AS rn
       FROM manual_subscription_grants g
       INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
       WHERE g.acknowledged_at IS NULL
         AND g.deleted_at IS NULL
         AND ds.status = 'active'
         AND ds.expires_at > now()
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND ds.transaction_id ~ $1
         AND g.id <= (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)
     )
     SELECT
       device_id,
       grant_id,
       duration_days,
       granted_at,
       acknowledged_at,
       deleted_at,
       sub_status,
       sub_expires_at,
       sub_transaction_id,
       'active_manual_grant_unacknowledged' AS qualify_reason
     FROM strict_pending
     WHERE rn = 1
     ORDER BY granted_at ASC`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: paymentWithUnacked } = await pool.query(
    `SELECT DISTINCT ON (g.device_id)
       g.device_id,
       g.id AS grant_id,
       ds.transaction_id AS sub_transaction_id,
       ds.status AS sub_status,
       ds.expires_at AS sub_expires_at,
       CASE
         WHEN ds.transaction_id ~ '^manual_grant:[0-9]+$' THEN false
         ELSE true
       END AS would_legacy_popup,
       EXISTS (
         SELECT 1
         FROM manual_subscription_grants g2
         INNER JOIN device_subscriptions ds2 ON ds2.device_id = g2.device_id
         WHERE g2.device_id = g.device_id
           AND g2.acknowledged_at IS NULL
           AND g2.deleted_at IS NULL
           AND ds2.status = 'active'
           AND ds2.expires_at > now()
           AND COALESCE(ds2.manual_admin_blocked, false) = false
           AND ds2.transaction_id ~ $1
           AND g2.id <= (regexp_replace(ds2.transaction_id, '^manual_grant:', '')::bigint)
       ) AS strict_popup_now
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.acknowledged_at IS NULL
       AND g.deleted_at IS NULL
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND COALESCE(ds.transaction_id, '') !~ $1
     ORDER BY g.device_id, g.created_at ASC`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: legacyOnlyFalsePositives } = await pool.query(
    `WITH pending AS (
       SELECT g.id, g.device_id
       FROM manual_subscription_grants g
       WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
     ),
     strict AS (
       SELECT g.id, g.device_id
       FROM manual_subscription_grants g
       INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
       WHERE g.acknowledged_at IS NULL
         AND g.deleted_at IS NULL
         AND ds.status = 'active'
         AND ds.expires_at > now()
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND ds.transaction_id ~ $1
         AND g.id <= (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)
     )
     SELECT p.device_id, MIN(p.id) AS oldest_pending_grant_id
     FROM pending p
     WHERE p.id NOT IN (SELECT id FROM strict)
     GROUP BY p.device_id
     ORDER BY p.device_id`,
    [MANUAL_GRANT_TXN_RE],
  )

  const stats = await countManualGiftAuditStats()
  const stale = await findStalePendingManualGiftGrants({ limit: 5000 })

  const { rows: q1 } = await pool.query(
    `SELECT COUNT(DISTINCT device_id)::int AS devices_with_pending_grants
     FROM manual_subscription_grants
     WHERE acknowledged_at IS NULL AND deleted_at IS NULL`,
  )

  const { rows: q2 } = await pool.query(
    `SELECT COUNT(*)::int AS grants_before_strict_fix
     FROM manual_subscription_grants
     WHERE acknowledged_at IS NULL AND deleted_at IS NULL AND created_at < $1::timestamptz`,
    [MANUAL_GIFT_STRICT_FIX_AT],
  )

  const { rows: q3 } = await pool.query(
    `SELECT COUNT(*)::int AS testing_grants_pending
     FROM manual_subscription_grants g
     WHERE g.deleted_at IS NULL AND g.acknowledged_at IS NULL AND ${TESTING_DEVICE_SQL}`,
  )

  const { rows: q4 } = await pool.query(
    `SELECT COUNT(DISTINCT g.device_id)::int AS devices_popup_while_non_manual_txn
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
       AND ds.status = 'active' AND ds.expires_at > now()
       AND COALESCE(ds.transaction_id, '') !~ $1`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: q5 } = await pool.query(
    `SELECT COUNT(DISTINCT g.device_id)::int AS paid_users_with_strict_popup
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     INNER JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
       AND ds.status = 'active' AND ds.expires_at > now()
       AND ds.transaction_id ~ '^osm(_sp)?_'
       AND EXISTS (
         SELECT 1 FROM manual_subscription_grants g2
         INNER JOIN device_subscriptions ds2 ON ds2.device_id = g2.device_id
         WHERE g2.device_id = g.device_id AND g2.acknowledged_at IS NULL AND g2.deleted_at IS NULL
           AND ds2.status = 'active' AND ds2.expires_at > now()
           AND ds2.transaction_id ~ $1
           AND g2.id <= (regexp_replace(ds2.transaction_id, '^manual_grant:', '')::bigint)
       )`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: q6 } = await pool.query(
    `SELECT COUNT(DISTINCT g.device_id)::int AS recovery_users_with_unacked
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
       AND ds.status = 'active' AND ds.expires_at > now()
       AND ds.transaction_id LIKE 'recovery:%'`,
  )

  const { rows: q7 } = await pool.query(
    `SELECT COUNT(DISTINCT g.device_id)::int AS transfer_users_with_unacked
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
       AND ds.transaction_id LIKE 'moved:%'`,
  )

  const { rows: q8 } = await pool.query(
    `SELECT COUNT(*)::int AS total_acked_grants,
            COUNT(*) FILTER (WHERE acknowledged_at >= now() - interval '24 hours')::int AS acked_last_24h
     FROM manual_subscription_grants
     WHERE acknowledged_at IS NOT NULL`,
  )

  const { rows: multiPending } = await pool.query(
    `SELECT
       g.device_id,
       COUNT(*)::int AS pending_grant_count,
       MIN(g.id) AS oldest_grant_id,
       MAX(g.id) AS newest_grant_id,
       (SELECT ds.transaction_id FROM device_subscriptions ds WHERE ds.device_id = g.device_id LIMIT 1) AS sub_transaction_id,
       (SELECT COUNT(*)::int
        FROM manual_subscription_grants g2
        INNER JOIN device_subscriptions ds2 ON ds2.device_id = g2.device_id
        WHERE g2.device_id = g.device_id
          AND g2.acknowledged_at IS NULL AND g2.deleted_at IS NULL
          AND ds2.status = 'active' AND ds2.expires_at > now()
          AND ds2.transaction_id ~ $1
          AND g2.id <= (regexp_replace(ds2.transaction_id, '^manual_grant:', '')::bigint)
       ) AS strict_popup_eligible_count
     FROM manual_subscription_grants g
     WHERE g.acknowledged_at IS NULL AND g.deleted_at IS NULL
     GROUP BY g.device_id
     HAVING COUNT(*) > 1
     ORDER BY pending_grant_count DESC, g.device_id
     LIMIT 40`,
    [MANUAL_GRANT_TXN_RE],
  )

  const { rows: ackSample } = await pool.query(
    `SELECT device_id, id AS grant_id, acknowledged_at
     FROM manual_subscription_grants
     WHERE acknowledged_at IS NOT NULL
     ORDER BY acknowledged_at DESC
     LIMIT 5`,
  )

  return {
    generated_at: new Date().toISOString(),
    strict_fix_deployed_at: MANUAL_GIFT_STRICT_FIX_AT,
    answers: {
      q1_devices_with_pending_grants: q1[0]?.devices_with_pending_grants ?? 0,
      q2_grants_before_strict_fix: q2[0]?.grants_before_strict_fix ?? 0,
      q3_testing_grants_pending: q3[0]?.testing_grants_pending ?? 0,
      q4_devices_popup_while_non_manual_txn: q4[0]?.devices_popup_while_non_manual_txn ?? 0,
      q5_paid_users_with_strict_popup: q5[0]?.paid_users_with_strict_popup ?? 0,
      q6_recovery_users_with_unacked: q6[0]?.recovery_users_with_unacked ?? 0,
      q7_transfer_users_with_unacked: q7[0]?.transfer_users_with_unacked ?? 0,
      q8_acknowledged_grants_total: q8[0]?.total_acked_grants ?? 0,
      q8_acknowledged_last_24h: q8[0]?.acked_last_24h ?? 0,
      q9_multi_grant_after_single_ack:
        'ACK updates one row; getOldestPendingManualGrant returns next FIFO grant if another pending exists (see multi_pending_devices)',
      q10_devices_with_multiple_pending: multiPending.length,
    },
    grant_counts: grantCounts[0] ?? {},
    audit_stats: stats,
    test_grants_still_pending: testPending,
    popup_devices: popupDevices,
    popup_device_count: popupDevices.length,
    multi_pending_devices: multiPending,
    recent_ack_sample: ackSample,
    payment_subscribers_with_unacked_grants: paymentWithUnacked,
    payment_subscribers_strict_popup_count: paymentWithUnacked.filter((r) => r.strict_popup_now).length,
    non_manual_legacy_false_positive_devices: legacyOnlyFalsePositives,
    stale_grants_for_repair: stale,
    stale_grant_count: stale.length,
  }
}
