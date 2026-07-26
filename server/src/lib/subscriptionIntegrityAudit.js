/**
 * Automatic Integrity Audit — read-only, 3× daily.
 * Never modifies expiry / entitlements. Reports anomalies + alerts only.
 */
import { getPool } from '../db/pool.js'
import {
  CANONICAL_ENGINE_VERSION,
  SUBSCRIPTION_SCHEMA_VERSION,
} from './subscriptionHardeningConstants.js'
import { computeRemainingCalendarDaysEat } from './subscriptionStacking.js'
import { isSubscriptionMigrationCompleted, migrationLockMeta } from './subscriptionMigrationLock.js'
import { legacyLockStatus } from './subscriptionLegacyLock.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function maskId(id) {
  const s = String(id ?? '').trim()
  if (!s) return null
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
})

/**
 * Read-only production integrity scan.
 */
export async function runSubscriptionIntegrityAudit({ slot = 'manual' } = {}) {
  const pool = requirePool()
  const startedAt = new Date().toISOString()
  const anomalies = []
  const nowMs = Date.now()

  const push = (a) => {
    anomalies.push({
      timestamp: new Date().toISOString(),
      severity: a.severity || SEVERITY.MEDIUM,
      reason: a.reason,
      device_id: a.device_id || null,
      device_id_masked: a.device_id ? maskId(a.device_id) : null,
      recommended_action: a.recommended_action || 'Investigate manually; do not auto-modify expiry',
      details: a.details || {},
    })
  }

  // 1) Status label still 'active' but expiry already passed (access layer treats as inactive).
  // Informational only — not over-credit; do not alert as high.
  {
    const { rows } = await pool.query(
      `SELECT device_id, status, expires_at, admin_revoked_at
       FROM device_subscriptions
       WHERE LOWER(COALESCE(status::text, '')) = 'active'
         AND (expires_at IS NULL OR expires_at <= now())
       LIMIT 500`,
    )
    for (const r of rows) {
      push({
        severity: SEVERITY.INFO,
        reason: 'stale_active_label_on_expired_row',
        device_id: r.device_id,
        recommended_action:
          'Optional cleanup: set status=revoked for naturally expired rows. Runtime already denies access via expires_at.',
        details: { expires_at: r.expires_at, admin_revoked_at: r.admin_revoked_at },
      })
    }
  }

  // 2) Active + admin revoked simultaneously
  {
    const { rows } = await pool.query(
      `SELECT device_id, status, expires_at, admin_revoked_at
       FROM device_subscriptions
       WHERE admin_revoked_at IS NOT NULL
         AND LOWER(COALESCE(status::text, '')) = 'active'
         AND expires_at > now()
       LIMIT 200`,
    )
    for (const r of rows) {
      push({
        severity: SEVERITY.CRITICAL,
        reason: 'active_while_admin_revoked',
        device_id: r.device_id,
        recommended_action: 'Align status to revoked; verify DELETE USER SSOT',
        details: { expires_at: r.expires_at, admin_revoked_at: r.admin_revoked_at },
      })
    }
  }

  // 3) Over-credit heuristic vs last completed plan (exclude transfer/recovery/manual).
  // Mild remaining > plan is often a legitimate pre-disable stack — info only.
  // Severe remaining (> 2× plan) is high.
  {
    const { rows } = await pool.query(
      `SELECT ds.device_id,
              ds.expires_at,
              ds.transaction_id,
              p.duration_days,
              p.name AS plan_name
       FROM device_subscriptions ds
       LEFT JOIN transactions t ON t.order_id = ds.transaction_id
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
         AND ds.expires_at > now()
         AND ds.admin_revoked_at IS NULL
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND p.duration_days IS NOT NULL
         AND ds.transaction_id IS NOT NULL
         AND ds.transaction_id NOT ILIKE 'transfer:%'
         AND ds.transaction_id NOT ILIKE 'recovery:%'
         AND ds.transaction_id NOT ILIKE 'manual_grant:%'
         AND ds.transaction_id NOT ILIKE 'moved:%'
       LIMIT 500`,
    )
    for (const r of rows) {
      const rem = computeRemainingCalendarDaysEat(r.expires_at, nowMs)
      const days = Math.max(1, Math.trunc(Number(r.duration_days) || 0))
      if (rem <= days + 2) continue
      const severe = rem > days * 2 + 2
      push({
        severity: severe ? SEVERITY.HIGH : SEVERITY.INFO,
        reason: severe ? 'suspected_over_credit_vs_last_plan' : 'possible_legacy_stack_remaining',
        device_id: r.device_id,
        recommended_action: severe
          ? 'Read-only flag only. Investigate payment history before any manual correction.'
          : 'Likely legitimate historical stack (stacking disabled for new purchases). Monitor only.',
        details: {
          remaining_days: rem,
          plan_duration_days: days,
          plan_name: r.plan_name,
          expires_at: r.expires_at,
        },
      })
    }
  }

  // 4) Duplicate active ownership impossible: same transaction_id on multiple devices
  {
    const { rows } = await pool.query(
      `SELECT transaction_id, COUNT(*)::int AS n, array_agg(device_id) AS device_ids
       FROM device_subscriptions
       WHERE transaction_id IS NOT NULL
         AND trim(transaction_id) <> ''
         AND LOWER(COALESCE(status::text, '')) = 'active'
         AND expires_at > now()
       GROUP BY transaction_id
       HAVING COUNT(*) > 1
       LIMIT 100`,
    )
    for (const r of rows) {
      push({
        severity: SEVERITY.CRITICAL,
        reason: 'duplicate_transaction_entitlement',
        device_id: Array.isArray(r.device_ids) ? r.device_ids[0] : null,
        recommended_action: 'Investigate duplicate entitlement for same order_id',
        details: { transaction_id: r.transaction_id, count: r.n, device_ids_masked: (r.device_ids || []).map(maskId) },
      })
    }
  }

  // 5) Schema / migration lock health
  const migrationCompleted = await isSubscriptionMigrationCompleted()
  if (!migrationCompleted) {
    push({
      severity: SEVERITY.CRITICAL,
      reason: 'migration_lock_not_sealed',
      recommended_action: 'Ensure ensureSubscriptionMigrationLockSealed runs on startup',
    })
  }

  const { rows: unversioned } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions
     WHERE migration_completed_at IS NULL
        OR canonical_engine_version IS NULL
        OR trim(COALESCE(canonical_engine_version, '')) = ''`,
  )
  if ((unversioned[0]?.n || 0) > 0) {
    push({
      severity: SEVERITY.MEDIUM,
      reason: 'rows_missing_migration_version_stamp',
      recommended_action: 'Re-run migration lock seal on next startup',
      details: { count: unversioned[0].n },
    })
  }

  // 6) Census counts
  const { rows: census } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE LOWER(COALESCE(status::text,'')) = 'active' AND expires_at > now() AND admin_revoked_at IS NULL)::int AS active_ok,
       COUNT(*) FILTER (WHERE LOWER(COALESCE(status::text,'')) = 'revoked' OR admin_revoked_at IS NOT NULL)::int AS revoked,
       COUNT(*)::int AS total
     FROM device_subscriptions`,
  )

  const legacy = await legacyLockStatus()
  const critical = anomalies.filter((a) => a.severity === SEVERITY.CRITICAL).length
  const high = anomalies.filter((a) => a.severity === SEVERITY.HIGH).length
  const hasAlert = critical > 0 || high > 0

  const report = {
    ok: !hasAlert,
    read_only: true,
    never_modifies_expiry: true,
    slot: String(slot || 'manual'),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    canonical_engine_version: CANONICAL_ENGINE_VERSION,
    subscription_schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    migration_lock: migrationLockMeta(),
    legacy_lock: legacy,
    census: census[0] || {},
    anomaly_count: anomalies.length,
    critical_count: critical,
    high_count: high,
    anomalies,
    alert: hasAlert
      ? {
          created: true,
          severity: critical > 0 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
          summary: `${critical} critical / ${high} high subscription integrity anomalies`,
        }
      : { created: false },
  }

  const insert = await pool.query(
    `INSERT INTO subscription_integrity_audit_reports
       (slot, started_at, finished_at, ok, anomaly_count, critical_count, high_count, report, alerted)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id`,
    [
      report.slot,
      report.started_at,
      report.finished_at,
      report.ok,
      report.anomaly_count,
      report.critical_count,
      report.high_count,
      JSON.stringify(report),
      hasAlert,
    ],
  )
  report.report_id = insert.rows[0]?.id ?? null

  if (hasAlert) {
    console.error('[integrity-audit] ALERT', {
      report_id: report.report_id,
      slot: report.slot,
      critical,
      high,
      anomaly_count: anomalies.length,
    })
    try {
      await pool.query(
        `INSERT INTO subscription_integrity_alerts
           (report_id, severity, summary, device_ids, details)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [
          report.report_id,
          critical > 0 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
          report.alert.summary,
          JSON.stringify(
            [...new Set(anomalies.map((a) => a.device_id).filter(Boolean))].slice(0, 200),
          ),
          JSON.stringify({ anomalies: anomalies.slice(0, 50) }),
        ],
      )
    } catch (e) {
      console.error('[integrity-audit] alert insert failed:', e?.message || e)
    }
  } else {
    console.log('[integrity-audit] clean', {
      report_id: report.report_id,
      slot: report.slot,
      active_ok: report.census.active_ok,
    })
  }

  return report
}

export async function getLatestIntegrityAuditReport() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT id, slot, started_at, finished_at, ok, anomaly_count, critical_count, high_count, alerted, report, created_at
     FROM subscription_integrity_audit_reports
     ORDER BY id DESC
     LIMIT 1`,
  )
  return rows[0] || null
}

export async function listIntegrityAuditReports({ limit = 20 } = {}) {
  const pool = requirePool()
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const { rows } = await pool.query(
    `SELECT id, slot, started_at, finished_at, ok, anomaly_count, critical_count, high_count, alerted, created_at
     FROM subscription_integrity_audit_reports
     ORDER BY id DESC
     LIMIT $1`,
    [lim],
  )
  return rows
}
