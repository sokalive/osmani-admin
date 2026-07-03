/**
 * Read-only production subscription incident statistics (exact SQL counts).
 */
import { getPool } from '../db/pool.js'
import { findFalseExpiredSubscriptions } from './subscriptionFalseExpiredRepair.js'
import { findIncorrectlyRevokedMigrationShadows, findIncorrectlySuspendedActive } from './subscriptionIncidentAudit.js'
import { findWrongDirectionMigrationVictims, countDeniedFutureEntitlement } from './subscriptionWrongDirectionRepair.js'
import { runSubscriptionRestorationAudit } from './subscriptionRestorationAudit.js'
import { findDuplicateActivePhoneClusters } from './subscriptionApiParityAudit.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function activationMethodSql(dsAlias = 'ds') {
  return `CASE
    WHEN COALESCE(${dsAlias}.transaction_id, '') LIKE 'moved:%' THEN 'transfer_source_revoked'
    WHEN COALESCE(${dsAlias}.transaction_id, '') LIKE 'recovery:%' THEN 'recovery'
    WHEN COALESCE(${dsAlias}.transaction_id, '') LIKE 'offer_code:%' THEN 'offer_code'
    WHEN COALESCE(${dsAlias}.transaction_id, '') LIKE 'transfer:%'
      OR COALESCE(${dsAlias}.transaction_id, '') LIKE 'force:TR-%' THEN 'transfer'
    WHEN COALESCE(${dsAlias}.transaction_id, '') LIKE 'repair:%' THEN 'repair'
    WHEN EXISTS (
      SELECT 1 FROM manual_subscription_grants mg
      WHERE mg.device_id = ${dsAlias}.device_id AND mg.deleted_at IS NULL
    ) THEN 'manual_grant'
    WHEN EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.device_id = ${dsAlias}.device_id AND t.status = 'completed' AND t.plan_id IS NOT NULL
    ) THEN 'payment'
    ELSE 'other'
  END`
}

export async function runSubscriptionIncidentDatabaseReport(pool = requirePool()) {
  const nowRow = await pool.query(
    `SELECT now() AS db_now_utc,
            now() AT TIME ZONE 'Africa/Nairobi' AS db_now_eat,
            current_setting('TIMEZONE') AS db_timezone`,
  )
  const dbNowUtc = nowRow.rows[0]?.db_now_utc
  const dbNowEat = nowRow.rows[0]?.db_now_eat
  const dbTimezone = String(nowRow.rows[0]?.db_timezone ?? '')

  const totals = (
    await pool.query(
      `SELECT
         COUNT(*)::int AS total_subscription_rows,
         COUNT(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS active_now,
         COUNT(*) FILTER (WHERE expires_at <= now())::int AS expired,
         COUNT(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS pending_future_expiry,
         COUNT(*) FILTER (WHERE status <> 'active' AND expires_at > now()
           AND COALESCE(transaction_id, '') NOT LIKE 'moved:%')::int AS non_active_future_expiry,
         COUNT(*) FILTER (WHERE COALESCE(manual_admin_blocked, false))::int AS manual_admin_blocked,
         COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'moved:%')::int AS moved_transfer_sources,
         COUNT(DISTINCT device_id)::int AS unique_devices
       FROM device_subscriptions`,
    )
  ).rows[0]

  const activeByMethod = (
    await pool.query(
      `SELECT ${activationMethodSql('ds')} AS activation_method,
              COUNT(*)::int AS count
       FROM device_subscriptions ds
       WHERE ds.status = 'active' AND ds.expires_at > now()
       GROUP BY 1
       ORDER BY count DESC`,
    )
  ).rows

  const securityTimeline = (
    await pool.query(
      `SELECT event_type,
              COUNT(*)::int AS event_count,
              COUNT(DISTINCT NULLIF(trim(actor), ''))::int AS distinct_actors,
              MIN(created_at) AS first_seen_at,
              MAX(created_at) AS last_seen_at
       FROM security_events
       WHERE event_type IN (
         'Subscription recovery',
         'Subscription revoked',
         'Transfer confirmation',
         'Code transfer',
         'Force transfer',
         'Transfer request'
       )
       GROUP BY event_type
       ORDER BY first_seen_at ASC NULLS LAST`,
    )
  ).rows

  const incidentEventEarliest = (
    await pool.query(
      `SELECT MIN(created_at) AS first_subscription_incident_event_at
       FROM security_events
       WHERE event_type IN ('Subscription recovery', 'Subscription revoked')
          OR lower(coalesce(detail, '')) LIKE '%subscription%'
          OR lower(coalesce(detail, '')) LIKE '%false%expired%'
          OR lower(coalesce(detail, '')) LIKE '%migration%shadow%'`,
    )
  ).rows[0]

  const pendingFutureByMethod = (
    await pool.query(
      `SELECT ${activationMethodSql('ds')} AS activation_method,
              COUNT(*)::int AS count
       FROM device_subscriptions ds
       WHERE ds.status = 'pending' AND ds.expires_at > now()
         AND COALESCE(ds.transaction_id, '') NOT LIKE 'moved:%'
       GROUP BY 1
       ORDER BY count DESC`,
    )
  ).rows

  const [
    falseExpired,
    suspended,
    shadows,
    wrongDirection,
    denied,
    restoration,
    duplicates,
  ] = await Promise.all([
    findFalseExpiredSubscriptions(pool),
    findIncorrectlySuspendedActive(pool),
    findIncorrectlyRevokedMigrationShadows(pool, { requireTelemetry: false }),
    findWrongDirectionMigrationVictims(pool),
    countDeniedFutureEntitlement(pool),
    runSubscriptionRestorationAudit({ repair: false, skipAutoLink: true }),
    findDuplicateActivePhoneClusters(pool),
  ])

  const duplicateExcess = duplicates.reduce((n, c) => n + Math.max(0, c.active_count - 1), 0)

  const affectedNow = new Set([
    ...falseExpired.affected.map((r) => r.device_id),
    ...suspended.map((r) => r.device_id),
    ...shadows.map((r) => r.device_id),
    ...wrongDirection.map((r) => r.shadow_device_id || r.device_id),
    ...(restoration.unresolved || []).map((r) => r.device_id),
  ])
  affectedNow.delete(undefined)
  affectedNow.delete('')

  const uniqueDevices = Number(totals.unique_devices) || 0
  const neverAffectedNow = Math.max(0, uniqueDevices - affectedNow.size)

  const restoreAudit = (
    await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'recovery:%')::int AS recovery_txn_rows,
         COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'offer_code:%')::int AS offer_code_txn_rows,
         COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'moved:%')::int AS moved_txn_rows,
         COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'transfer:%'
           OR COALESCE(transaction_id, '') LIKE 'force:TR-%')::int AS transfer_txn_rows
       FROM device_subscriptions`,
    )
  ).rows[0]

  const manualGrants = (
    await pool.query(
      `SELECT COUNT(*)::int AS total_grants,
              COUNT(DISTINCT device_id)::int AS distinct_devices
       FROM manual_subscription_grants
       WHERE deleted_at IS NULL`,
    )
  ).rows[0]

  const transfers = (
    await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM device_transfers
       GROUP BY status
       ORDER BY status`,
    )
  ).rows

  const currentIssues = {
    false_expired: falseExpired.affected_count,
    incorrectly_suspended: suspended.length,
    incorrect_revoked_shadows: shadows.length,
    wrong_direction_victims: wrongDirection.length,
    restoration_unresolved: restoration.unresolved_users_count ?? 0,
    duplicate_phone_active_excess: duplicateExcess,
    denied_future_entitlement: Number(denied.total_denied_future) || 0,
    pending_future_non_moved: Number(totals.pending_future_expiry) || 0,
    non_active_future_non_moved: Number(totals.non_active_future_expiry) || 0,
  }

  const remainingIncorrect = Object.values(currentIssues).reduce((a, b) => a + Number(b || 0), 0)

  return {
    server_time_utc: dbNowUtc instanceof Date ? dbNowUtc.toISOString() : String(dbNowUtc ?? ''),
    server_time_eat: dbNowEat instanceof Date ? dbNowEat.toISOString() : String(dbNowEat ?? ''),
    database_timezone: dbTimezone,
    subscription_totals: totals,
    active_by_activation_method: activeByMethod,
    pending_future_by_activation_method: pendingFutureByMethod,
    transaction_id_prefix_totals: restoreAudit,
    manual_grants: manualGrants,
    device_transfers: transfers,
    security_events_timeline: securityTimeline,
    first_subscription_incident_signal_at:
      incidentEventEarliest?.first_subscription_incident_event_at instanceof Date
        ? incidentEventEarliest.first_subscription_incident_event_at.toISOString()
        : incidentEventEarliest?.first_subscription_incident_event_at ?? null,
    current_issues: currentIssues,
    remaining_incorrect_users: affectedNow.size,
    remaining_issue_score: remainingIncorrect,
    unique_devices_never_in_current_issue_set: neverAffectedNow,
    total_unique_devices: uniqueDevices,
    denied_future_breakdown: denied,
    restoration_audit: {
      affected_users_count: restoration.affected_users_count,
      unresolved_users_count: restoration.unresolved_users_count,
      restored_users_count: restoration.restored_users_count,
      total_active_subscriptions: restoration.total_active_subscriptions,
    },
    false_expired_root_cause: falseExpired.root_cause,
    sql_evidence_note:
      'Counts are live PostgreSQL aggregates on device_subscriptions, security_events, manual_subscription_grants, and device_transfers. Git commit causation is not stored in the production database.',
  }
}
