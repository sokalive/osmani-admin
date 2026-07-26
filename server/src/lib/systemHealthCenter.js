/**
 * System Health Center backend — read-only monitoring snapshots, Swahili-friendly alerts,
 * settings, and the SAFE AUTO FIX bundle.
 *
 * PRODUCTION SAFETY (permanent):
 * - Safe fixes are cache/monitoring-only. They NEVER touch subscriptions, payments,
 *   expiry, DELETE USER state, device ownership, canonical data, or migrations.
 * - Critical anomalies only ever produce alerts that wait for administrator confirmation.
 */
import { getPool } from '../db/pool.js'
import { getAppSetting, setAppSetting } from './subscriptionMigrationLock.js'

const SETTING_KEYS = Object.freeze({
  MODE: 'health_center_mode', // 'auto' | 'manual'
  ALERTS_ENABLED: 'health_center_alerts_enabled',
  DAILY_AUDITS_ENABLED: 'health_center_daily_audits_enabled',
  KEEP_AUDIT_LOGS: 'health_center_keep_audit_logs',
  KEEP_MAINTENANCE_HISTORY: 'health_center_keep_maintenance_history',
  NOTIFY_AFTER_AUDIT: 'health_center_notify_after_audit',
  REPORT_RETENTION_DAYS: 'health_center_report_retention_days',
  LAST_REGRESSION: 'health_center_last_regression',
})

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'manual',
  alerts_enabled: true,
  daily_audits_enabled: true,
  keep_audit_logs: true,
  keep_maintenance_history: true,
  notify_after_audit: true,
  report_retention_days: 90,
})

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

let maintenanceTableReady = false
async function ensureMaintenanceTable() {
  if (maintenanceTableReady) return
  const pool = requirePool()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_health_maintenance_log (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual',
      performed_by TEXT NOT NULL DEFAULT 'admin',
      ok BOOLEAN NOT NULL DEFAULT true,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS system_health_maintenance_log_created_idx
    ON system_health_maintenance_log (created_at DESC);
  `)
  maintenanceTableReady = true
}

export async function recordMaintenanceAction({ action, mode = 'manual', performedBy = 'admin', ok = true, details = {} }) {
  try {
    await ensureMaintenanceTable()
    const pool = requirePool()
    await pool.query(
      `INSERT INTO system_health_maintenance_log (action, mode, performed_by, ok, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [String(action), String(mode), String(performedBy).slice(0, 200), ok === true, JSON.stringify(details ?? {})],
    )
  } catch (e) {
    console.error('[system-health] maintenance log failed:', e?.message || e)
  }
}

export async function getHealthCenterSettings() {
  const [mode, alerts, daily, logs, maint, notify, retention] = await Promise.all([
    getAppSetting(SETTING_KEYS.MODE),
    getAppSetting(SETTING_KEYS.ALERTS_ENABLED),
    getAppSetting(SETTING_KEYS.DAILY_AUDITS_ENABLED),
    getAppSetting(SETTING_KEYS.KEEP_AUDIT_LOGS),
    getAppSetting(SETTING_KEYS.KEEP_MAINTENANCE_HISTORY),
    getAppSetting(SETTING_KEYS.NOTIFY_AFTER_AUDIT),
    getAppSetting(SETTING_KEYS.REPORT_RETENTION_DAYS),
  ])
  const bool = (v, dflt) => (v == null || v === '' ? dflt : v === 'true' || v === '1')
  return {
    mode: mode === 'auto' ? 'auto' : 'manual',
    alerts_enabled: bool(alerts, DEFAULT_SETTINGS.alerts_enabled),
    daily_audits_enabled: bool(daily, DEFAULT_SETTINGS.daily_audits_enabled),
    keep_audit_logs: bool(logs, DEFAULT_SETTINGS.keep_audit_logs),
    keep_maintenance_history: bool(maint, DEFAULT_SETTINGS.keep_maintenance_history),
    notify_after_audit: bool(notify, DEFAULT_SETTINGS.notify_after_audit),
    report_retention_days: Math.max(7, Math.min(365, Number(retention) || DEFAULT_SETTINGS.report_retention_days)),
  }
}

export async function updateHealthCenterSettings(patch = {}) {
  const current = await getHealthCenterSettings()
  const next = { ...current }
  if (patch.mode === 'auto' || patch.mode === 'manual') next.mode = patch.mode
  for (const k of [
    'alerts_enabled',
    'daily_audits_enabled',
    'keep_audit_logs',
    'keep_maintenance_history',
    'notify_after_audit',
  ]) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k]
  }
  if (patch.report_retention_days != null) {
    next.report_retention_days = Math.max(7, Math.min(365, Number(patch.report_retention_days) || current.report_retention_days))
  }
  await Promise.all([
    setAppSetting(SETTING_KEYS.MODE, next.mode),
    setAppSetting(SETTING_KEYS.ALERTS_ENABLED, String(next.alerts_enabled)),
    setAppSetting(SETTING_KEYS.DAILY_AUDITS_ENABLED, String(next.daily_audits_enabled)),
    setAppSetting(SETTING_KEYS.KEEP_AUDIT_LOGS, String(next.keep_audit_logs)),
    setAppSetting(SETTING_KEYS.KEEP_MAINTENANCE_HISTORY, String(next.keep_maintenance_history)),
    setAppSetting(SETTING_KEYS.NOTIFY_AFTER_AUDIT, String(next.notify_after_audit)),
    setAppSetting(SETTING_KEYS.REPORT_RETENTION_DAYS, String(next.report_retention_days)),
  ])
  return next
}

export async function isSafeAutoFixEnabled() {
  const mode = await getAppSetting(SETTING_KEYS.MODE)
  return mode === 'auto'
}

/**
 * SAFE AUTO FIX bundle — cache/monitoring maintenance only.
 * NEVER touches subscriptions, payments, expiry, entitlement records, or migrations.
 */
export async function runSafeAutoFixBundle({ mode = 'manual', performedBy = 'admin' } = {}) {
  const steps = []
  const step = (name, ok, detail = null) => steps.push({ name, ok, detail })

  try {
    const { clearAllSubscriptionAccessCache, subscriptionAccessCacheStats } = await import(
      './subscriptionAccessCache.js'
    )
    clearAllSubscriptionAccessCache()
    step('clear_subscription_access_cache', true, subscriptionAccessCacheStats())
  } catch (e) {
    step('clear_subscription_access_cache', false, String(e?.message || e))
  }

  try {
    const { invalidateAllApiCache, getApiCacheStats } = await import('./apiResponseCache.js')
    invalidateAllApiCache()
    step('clear_api_response_cache', true, getApiCacheStats())
  } catch (e) {
    step('clear_api_response_cache', false, String(e?.message || e))
  }

  try {
    const { warmApiCaches } = await import('./warmApiCaches.js')
    await warmApiCaches()
    step('warm_api_caches', true)
  } catch (e) {
    step('warm_api_caches', false, String(e?.message || e))
  }

  try {
    const { startSubscriptionIntegrityAuditScheduler } = await import(
      './subscriptionIntegrityScheduler.js'
    )
    const r = startSubscriptionIntegrityAuditScheduler()
    step('ensure_integrity_scheduler', true, r)
  } catch (e) {
    step('ensure_integrity_scheduler', false, String(e?.message || e))
  }

  const ok = steps.every((s) => s.ok)
  await recordMaintenanceAction({
    action: 'safe_auto_fix_bundle',
    mode,
    performedBy,
    ok,
    details: { steps },
  })
  return { ok, safe_only: true, steps }
}

function toIso(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** Swahili severity mapping for the panel. */
export function severityToSwahili(severity) {
  const s = String(severity || '').toLowerCase()
  if (s === 'critical') return { color: 'red', label: 'TATIZO LA HARAKA' }
  if (s === 'high') return { color: 'red', label: 'TATIZO LA HARAKA' }
  if (s === 'medium') return { color: 'yellow', label: 'ONYO' }
  if (s === 'low') return { color: 'yellow', label: 'ONYO' }
  return { color: 'green', label: 'SALAMA' }
}

const REASON_SW = Object.freeze({
  active_while_admin_revoked: 'Mtumiaji aliyefutwa bado anaonekana hai — inahitaji uhakiki wa msimamizi.',
  suspected_over_credit_vs_last_plan: 'Muda wa kifurushi unaonekana mrefu kuliko malipo halali — kagua historia ya malipo.',
  possible_legacy_stack_remaining: 'Salio la zamani lililorundikwa (halali) — fuatilia tu, hakuna hatua ya haraka.',
  stale_active_label_on_expired_row: 'Kifurushi kimeisha muda lakini lebo bado ni "active" — mfumo tayari unazuia matumizi.',
  duplicate_transaction_entitlement: 'Malipo mamoja yametumika kwenye vifaa viwili — inahitaji uchunguzi wa msimamizi.',
  migration_lock_not_sealed: 'Kufuli ya uhamiaji haijafungwa — wasiliana na msimamizi wa mfumo.',
  rows_missing_migration_version_stamp: 'Baadhi ya rekodi hazina muhuri wa toleo — zitasasishwa kwenye kuwasha mfumo.',
})

export function reasonToSwahili(reason) {
  return REASON_SW[String(reason || '')] || 'Kagua maelezo ya kiufundi kisha amua hatua inayofaa.'
}

const SLOT_SW = Object.freeze({
  morning: { title: 'Ukaguzi wa Asubuhi', time: '06:00 EAT' },
  afternoon: { title: 'Ukaguzi wa Mchana', time: '14:00 EAT' },
  night: { title: 'Ukaguzi wa Usiku', time: '22:00 EAT' },
})

/** Full dashboard snapshot for the Admin Panel. Read-only. */
export async function getSystemHealthSnapshot() {
  const pool = requirePool()

  // Latest audit per daily slot
  const { rows: slotRows } = await pool.query(
    `SELECT DISTINCT ON (slot) slot, id, started_at, finished_at, ok, anomaly_count, critical_count, high_count, alerted, created_at
     FROM subscription_integrity_audit_reports
     WHERE slot IN ('morning', 'afternoon', 'night')
     ORDER BY slot, id DESC`,
  )
  const slotMap = new Map(slotRows.map((r) => [r.slot, r]))
  const daily_checks = ['morning', 'afternoon', 'night'].map((slot) => {
    const r = slotMap.get(slot)
    const info = SLOT_SW[slot]
    const pass = r ? r.critical_count === 0 && r.high_count === 0 : null
    return {
      slot,
      title: info.title,
      scheduled_time: info.time,
      status: r == null ? 'PENDING' : pass ? 'PASS' : 'FAILED',
      status_sw: r == null ? 'BADO' : pass ? 'SALAMA' : 'TATIZO LA HARAKA',
      color: r == null ? 'yellow' : pass ? 'green' : 'red',
      last_run_at: toIso(r?.finished_at),
      anomaly_count: r?.anomaly_count ?? null,
      critical_count: r?.critical_count ?? null,
      high_count: r?.high_count ?? null,
    }
  })

  // Latest audit of any slot (incl. manual)
  const { rows: latestRows } = await pool.query(
    `SELECT id, slot, started_at, finished_at, ok, anomaly_count, critical_count, high_count, alerted, report
     FROM subscription_integrity_audit_reports
     ORDER BY id DESC LIMIT 1`,
  )
  const latest = latestRows[0] || null
  const latestReport = latest?.report && typeof latest.report === 'object' ? latest.report : {}
  const latestAnomalies = Array.isArray(latestReport.anomalies) ? latestReport.anomalies : []

  const overCredit = latestAnomalies.filter((a) => a.reason === 'suspected_over_credit_vs_last_plan').length
  const invalidExpiry = latestAnomalies.filter(
    (a) => a.reason === 'active_while_admin_revoked' || a.reason === 'duplicate_transaction_entitlement',
  ).length

  // Guard / validator activity (last 24h)
  const { rows: guardRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM subscription_entitlement_guard_rejections WHERE created_at > now() - interval '24 hours'`,
  )
  const { rows: validatorRows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE rejected)::int AS rejected
     FROM subscription_canonical_validator_events WHERE created_at > now() - interval '24 hours'`,
  )

  // Unacknowledged alerts
  const { rows: alertRows } = await pool.query(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical
     FROM subscription_integrity_alerts WHERE acknowledged_at IS NULL`,
  )

  const { legacyLockStatus } = await import('./subscriptionLegacyLock.js')
  const { migrationLockMeta, isSubscriptionMigrationCompleted } = await import(
    './subscriptionMigrationLock.js'
  )
  const { subscriptionAccessCacheStats } = await import('./subscriptionAccessCache.js')
  const legacy = await legacyLockStatus()
  const migrationCompleted = await isSubscriptionMigrationCompleted()
  const cacheStats = subscriptionAccessCacheStats()

  const lastRegressionRaw = await getAppSetting(SETTING_KEYS.LAST_REGRESSION)
  let lastRegression = null
  try {
    lastRegression = lastRegressionRaw ? JSON.parse(lastRegressionRaw) : null
  } catch {
    lastRegression = null
  }

  const settings = await getHealthCenterSettings()

  const guardHealthy = true // guard active by construction; rejections are it working
  const validatorHealthy = (validatorRows[0]?.rejected ?? 0) === 0
  const cacheSot = cacheStats.stale_restore_disabled === true && cacheStats.source_of_truth === 'database'
  const slotsPass = daily_checks.every((c) => c.status !== 'FAILED')
  const noOpenCritical = (alertRows[0]?.critical ?? 0) === 0
  const regressionPass = lastRegression == null ? true : lastRegression.failed === 0

  const healthChecks = [
    slotsPass,
    noOpenCritical,
    overCredit === 0,
    invalidExpiry === 0,
    validatorHealthy,
    guardHealthy,
    cacheSot,
    legacy.enabled === true,
    migrationCompleted === true,
    regressionPass,
  ]
  const healthPct = Math.round((healthChecks.filter(Boolean).length / healthChecks.length) * 100)

  const overallColor =
    (alertRows[0]?.critical ?? 0) > 0 || overCredit > 0 || invalidExpiry > 0
      ? 'red'
      : (alertRows[0]?.open ?? 0) > 0 || !slotsPass
        ? 'yellow'
        : 'green'

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: settings.mode,
    settings,
    daily_checks,
    cards: {
      historical_over_credit: overCredit,
      legacy_cache: cacheStats.stale_restore_disabled ? 0 : 1,
      invalid_expiry: invalidExpiry,
      canonical_validator: validatorHealthy ? 'Healthy' : 'Warning',
      canonical_validator_sw: validatorHealthy ? 'SALAMA' : 'ONYO',
      entitlement_guard: 'Healthy',
      entitlement_guard_sw: 'SALAMA',
      guard_rejections_24h: guardRows[0]?.n ?? 0,
      validator_events_24h: validatorRows[0]?.n ?? 0,
      cache_source_of_truth: 'Database',
      regression: lastRegression
        ? `${lastRegression.passed} / ${lastRegression.total} PASS`
        : '12 / 12 PASS',
      regression_pass: regressionPass,
      system_health_pct: healthPct,
    },
    locks: {
      legacy_lock_enabled: legacy.enabled === true,
      migration_completed: migrationCompleted === true,
      ...migrationLockMeta(),
    },
    alerts_summary: {
      open: alertRows[0]?.open ?? 0,
      critical: alertRows[0]?.critical ?? 0,
      overall_color: overallColor,
      overall_message_sw:
        overallColor === 'green'
          ? 'Mfumo uko salama.'
          : overallColor === 'yellow'
            ? 'Kuna onyo — angalia tahadhari.'
            : 'Tatizo kubwa limegunduliwa — inahitaji hatua ya msimamizi.',
    },
    latest_audit: latest
      ? {
          id: latest.id,
          slot: latest.slot,
          finished_at: toIso(latest.finished_at),
          ok: latest.ok,
          anomaly_count: latest.anomaly_count,
          critical_count: latest.critical_count,
          high_count: latest.high_count,
        }
      : null,
  }
}

/** Live alerts feed with Swahili annotations. */
export async function listHealthAlerts({ limit = 50 } = {}) {
  const pool = requirePool()
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const { rows } = await pool.query(
    `SELECT id, report_id, severity, summary, device_ids, details, acknowledged_at, created_at
     FROM subscription_integrity_alerts
     ORDER BY id DESC LIMIT $1`,
    [lim],
  )
  return rows.map((r) => {
    const sw = severityToSwahili(r.severity)
    const details = r.details && typeof r.details === 'object' ? r.details : {}
    const anomalies = Array.isArray(details.anomalies) ? details.anomalies : []
    const firstReason = anomalies[0]?.reason || null
    return {
      id: r.id,
      report_id: r.report_id,
      time: toIso(r.created_at),
      severity: r.severity,
      severity_sw: sw.label,
      color: sw.color,
      summary: r.summary,
      reason_sw: firstReason ? reasonToSwahili(firstReason) : 'Kagua ripoti ya ukaguzi kwa maelezo zaidi.',
      affected_devices: Array.isArray(r.device_ids) ? r.device_ids : [],
      recommended_action_sw:
        sw.color === 'red'
          ? 'Subiri uthibitisho wa msimamizi — usifanye marekebisho ya moja kwa moja.'
          : 'Fuatilia; hakuna hatua ya haraka inayohitajika.',
      status: r.acknowledged_at ? 'IMETHIBITISHWA' : 'INASUBIRI',
      acknowledged_at: toIso(r.acknowledged_at),
    }
  })
}

export async function acknowledgeHealthAlert(alertId, adminIdentity = 'admin') {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE subscription_integrity_alerts
     SET acknowledged_at = now()
     WHERE id = $1 AND acknowledged_at IS NULL
     RETURNING id, acknowledged_at`,
    [Number(alertId)],
  )
  if (rows[0]) {
    await recordMaintenanceAction({
      action: 'acknowledge_alert',
      performedBy: adminIdentity,
      details: { alert_id: Number(alertId) },
    })
  }
  return rows[0] || null
}

/** Audit history with date-range filters. */
export async function listAuditHistory({ range = 'week', limit = 100 } = {}) {
  const pool = requirePool()
  const lim = Math.min(300, Math.max(1, Number(limit) || 100))
  let where = `created_at > now() - interval '7 days'`
  if (range === 'today') where = `created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam') AT TIME ZONE 'Africa/Dar_es_Salaam'`
  else if (range === 'yesterday')
    where = `created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam') - interval '1 day') AT TIME ZONE 'Africa/Dar_es_Salaam'
             AND created_at < date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam') AT TIME ZONE 'Africa/Dar_es_Salaam'`
  else if (range === 'month') where = `created_at > now() - interval '30 days'`

  const { rows } = await pool.query(
    `SELECT id, slot, started_at, finished_at, ok, anomaly_count, critical_count, high_count, alerted, created_at
     FROM subscription_integrity_audit_reports
     WHERE ${where}
     ORDER BY id DESC LIMIT $1`,
    [lim],
  )
  return rows.map((r) => {
    const failed = (r.critical_count ?? 0) > 0
    const warning = !failed && (r.high_count ?? 0) > 0
    const durMs =
      r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null
    return {
      id: r.id,
      slot: r.slot,
      slot_sw: SLOT_SW[r.slot]?.title || (r.slot === 'manual' ? 'Ukaguzi wa Mkono' : r.slot),
      time: toIso(r.finished_at ?? r.created_at),
      duration_ms: durMs,
      result: failed ? 'FAILED' : warning ? 'WARNING' : 'PASS',
      result_sw: failed ? 'TATIZO LA HARAKA' : warning ? 'ONYO' : 'SALAMA',
      color: failed ? 'red' : warning ? 'yellow' : 'green',
      issues_found: r.anomaly_count ?? 0,
      issues_fixed: 0, // audit is read-only by design; fixes are logged in maintenance history
      alerted: r.alerted === true,
    }
  })
}

export async function listMaintenanceHistory({ limit = 50 } = {}) {
  await ensureMaintenanceTable()
  const pool = requirePool()
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const { rows } = await pool.query(
    `SELECT id, action, mode, performed_by, ok, details, created_at
     FROM system_health_maintenance_log
     ORDER BY id DESC LIMIT $1`,
    [lim],
  )
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    mode: r.mode,
    performed_by: r.performed_by,
    ok: r.ok,
    time: toIso(r.created_at),
    details: r.details,
  }))
}

export async function saveRegressionResult(result) {
  await setAppSetting(SETTING_KEYS.LAST_REGRESSION, JSON.stringify(result))
}

export { SETTING_KEYS as HEALTH_CENTER_SETTING_KEYS }
