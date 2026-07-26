/**
 * 🛡️ System Health Center admin API — /api/admin/system-health/*
 *
 * PRODUCTION SAFETY: every action here goes through the existing protection layers
 * (Entitlement Guard, Canonical Validator, Migration Lock, Legacy Lock).
 * SAFE AUTO FIX handles cache/monitoring maintenance only; critical subscription /
 * payment / expiry issues always wait for administrator confirmation.
 */
import { Router } from 'express'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  acknowledgeHealthAlert,
  getHealthCenterSettings,
  getSystemHealthSnapshot,
  listAuditHistory,
  listHealthAlerts,
  listMaintenanceHistory,
  recordMaintenanceAction,
  runSafeAutoFixBundle,
  saveRegressionResult,
  updateHealthCenterSettings,
} from '../lib/systemHealthCenter.js'

export const systemHealthAdminRouter = Router()
systemHealthAdminRouter.use(requireAdminPanelAccess)

function adminIdentity(req) {
  return String(req.adminAuth?.userId ?? 'admin').slice(0, 200)
}

function fail(res, e, label) {
  console.error(`[system-health-admin] ${label}:`, e)
  res.status(500).json({ ok: false, error: String(e?.message || e) })
}

systemHealthAdminRouter.get('/snapshot', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    res.json(await getSystemHealthSnapshot())
  } catch (e) {
    fail(res, e, 'snapshot')
  }
})

systemHealthAdminRouter.get('/alerts', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({ ok: true, alerts: await listHealthAlerts({ limit: req.query.limit }) })
  } catch (e) {
    fail(res, e, 'alerts')
  }
})

systemHealthAdminRouter.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const row = await acknowledgeHealthAlert(req.params.id, adminIdentity(req))
    res.json({ ok: true, acknowledged: Boolean(row), alert: row })
  } catch (e) {
    fail(res, e, 'acknowledge')
  }
})

systemHealthAdminRouter.get('/audits', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      range: String(req.query.range || 'week'),
      audits: await listAuditHistory({ range: String(req.query.range || 'week'), limit: req.query.limit }),
    })
  } catch (e) {
    fail(res, e, 'audits')
  }
})

systemHealthAdminRouter.get('/maintenance', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({ ok: true, maintenance: await listMaintenanceHistory({ limit: req.query.limit }) })
  } catch (e) {
    fail(res, e, 'maintenance')
  }
})

systemHealthAdminRouter.get('/settings', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({ ok: true, settings: await getHealthCenterSettings() })
  } catch (e) {
    fail(res, e, 'settings-get')
  }
})

systemHealthAdminRouter.put('/settings', async (req, res) => {
  try {
    const settings = await updateHealthCenterSettings(req.body || {})
    await recordMaintenanceAction({
      action: 'update_settings',
      performedBy: adminIdentity(req),
      details: { settings },
    })
    res.json({ ok: true, settings })
  } catch (e) {
    fail(res, e, 'settings-put')
  }
})

systemHealthAdminRouter.post('/mode', async (req, res) => {
  try {
    const mode = req.body?.mode === 'auto' ? 'auto' : 'manual'
    const settings = await updateHealthCenterSettings({ mode })
    await recordMaintenanceAction({
      action: 'set_mode',
      mode,
      performedBy: adminIdentity(req),
      details: { mode },
    })
    res.json({ ok: true, mode: settings.mode })
  } catch (e) {
    fail(res, e, 'mode')
  }
})

/** ▶ Endesha Ukaguzi Sasa — read-only integrity audit. */
systemHealthAdminRouter.post('/actions/run-audit', async (req, res) => {
  try {
    const { runSubscriptionIntegrityAudit } = await import('../lib/subscriptionIntegrityAudit.js')
    const report = await runSubscriptionIntegrityAudit({ slot: 'manual' })
    await recordMaintenanceAction({
      action: 'run_integrity_audit',
      performedBy: adminIdentity(req),
      ok: report.ok !== false || report.critical_count === 0,
      details: {
        report_id: report.report_id,
        anomaly_count: report.anomaly_count,
        critical_count: report.critical_count,
        high_count: report.high_count,
      },
    })
    res.json({ ok: true, report })
  } catch (e) {
    fail(res, e, 'run-audit')
  }
})

/** ▶ Safisha Cache — safe cache maintenance only. */
systemHealthAdminRouter.post('/actions/clear-cache', async (req, res) => {
  try {
    const result = await runSafeAutoFixBundle({ mode: 'manual', performedBy: adminIdentity(req) })
    res.json({ ok: result.ok, ...result })
  } catch (e) {
    fail(res, e, 'clear-cache')
  }
})

/** ▶ Kagua Database — read-only consistency counts. */
systemHealthAdminRouter.post('/actions/check-database', async (req, res) => {
  try {
    const { getPool } = await import('../db/pool.js')
    const pool = getPool()
    if (!pool) throw new Error('DATABASE_URL is required')
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM device_subscriptions) AS subscriptions_total,
         (SELECT COUNT(*)::int FROM device_subscriptions WHERE LOWER(COALESCE(status::text,''))='active' AND expires_at > now() AND admin_revoked_at IS NULL) AS active_valid,
         (SELECT COUNT(*)::int FROM device_subscriptions WHERE admin_revoked_at IS NOT NULL AND LOWER(COALESCE(status::text,''))='active' AND expires_at > now()) AS active_while_revoked,
         (SELECT COUNT(*)::int FROM transactions WHERE status = 'completed') AS completed_payments,
         (SELECT COUNT(*)::int FROM device_subscriptions WHERE migration_completed_at IS NULL) AS missing_migration_stamp`,
    )
    const r = rows[0]
    const ok = (r.active_while_revoked ?? 0) === 0
    await recordMaintenanceAction({
      action: 'check_database',
      performedBy: adminIdentity(req),
      ok,
      details: r,
    })
    res.json({
      ok,
      read_only: true,
      result: r,
      message_sw: ok
        ? 'Database iko salama — hakuna mgongano wa rekodi.'
        : 'Kuna rekodi zinazohitaji uhakiki wa msimamizi.',
    })
  } catch (e) {
    fail(res, e, 'check-database')
  }
})

/** ▶ Kagua Canonical Engine — validator activity, read-only. */
systemHealthAdminRouter.post('/actions/check-canonical', async (req, res) => {
  try {
    const { getPool } = await import('../db/pool.js')
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS events,
              COUNT(*) FILTER (WHERE rejected)::int AS rejected
       FROM subscription_canonical_validator_events
       WHERE created_at > now() - interval '24 hours'`,
    )
    const healthy = (rows[0]?.rejected ?? 0) === 0
    await recordMaintenanceAction({
      action: 'check_canonical_engine',
      performedBy: adminIdentity(req),
      ok: healthy,
      details: rows[0],
    })
    res.json({
      ok: true,
      healthy,
      last_24h: rows[0],
      message_sw: healthy
        ? 'Canonical Engine iko salama — hakuna data isiyolingana iliyotolewa.'
        : 'Canonical Validator imezuia data isiyolingana — kagua matukio.',
    })
  } catch (e) {
    fail(res, e, 'check-canonical')
  }
})

/** ▶ Kagua Entitlement Guard — rejection log, read-only. */
systemHealthAdminRouter.post('/actions/check-guard', async (req, res) => {
  try {
    const { getPool } = await import('../db/pool.js')
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS rejections_24h FROM subscription_entitlement_guard_rejections
       WHERE created_at > now() - interval '24 hours'`,
    )
    const { rows: recent } = await pool.query(
      `SELECT code, source, created_at FROM subscription_entitlement_guard_rejections
       ORDER BY id DESC LIMIT 10`,
    )
    await recordMaintenanceAction({
      action: 'check_entitlement_guard',
      performedBy: adminIdentity(req),
      ok: true,
      details: { rejections_24h: rows[0]?.rejections_24h ?? 0 },
    })
    res.json({
      ok: true,
      healthy: true,
      rejections_24h: rows[0]?.rejections_24h ?? 0,
      recent_rejections: recent,
      message_sw:
        'Entitlement Guard inafanya kazi — maandishi yote ya vifurushi yanapita kwenye ulinzi. Kukataliwa ni ulinzi ukifanya kazi.',
    })
  } catch (e) {
    fail(res, e, 'check-guard')
  }
})

/** ▶ Kagua Legacy Lock — lock status, read-only. */
systemHealthAdminRouter.post('/actions/check-legacy-lock', async (req, res) => {
  try {
    const { legacyLockStatus } = await import('../lib/subscriptionLegacyLock.js')
    const { migrationLockMeta, isSubscriptionMigrationCompleted } = await import(
      '../lib/subscriptionMigrationLock.js'
    )
    const legacy = await legacyLockStatus()
    const migrationCompleted = await isSubscriptionMigrationCompleted()
    const ok = legacy.enabled === true && migrationCompleted === true
    await recordMaintenanceAction({
      action: 'check_legacy_lock',
      performedBy: adminIdentity(req),
      ok,
      details: { legacy, migrationCompleted },
    })
    res.json({
      ok,
      legacy,
      migration: { ...migrationLockMeta(), completed: migrationCompleted },
      message_sw: ok
        ? 'Kufuli za Legacy na Migration zimefungwa — njia za zamani haziwezi kutumika tena.'
        : 'ONYO: Kufuli hazijafungwa kikamilifu — wasiliana na msimamizi wa mfumo.',
    })
  } catch (e) {
    fail(res, e, 'check-legacy-lock')
  }
})

/** ▶ Kagua Regression — run the permanent suite in a pure subprocess (no DB writes). */
systemHealthAdminRouter.post('/actions/check-regression', async (req, res) => {
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'regression-subscription-hardening.mjs')
  execFile(
    process.execPath,
    [scriptPath],
    {
      timeout: 90_000,
      env: { ...process.env, DATABASE_URL: '' },
      cwd: process.cwd(),
    },
    async (err, stdout, stderr) => {
      try {
        const out = String(stdout || '')
        const jsonMatch = out.match(/\{[\s\S]*"total"[\s\S]*\}/)
        let parsed = null
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0])
          } catch {
            parsed = null
          }
        }
        const result = {
          ok: !err,
          total: parsed?.total ?? null,
          passed: parsed?.passed ?? null,
          failed: parsed?.failed ?? (err ? 1 : 0),
          failed_names: parsed?.failed_names ?? [],
          ran_at: new Date().toISOString(),
        }
        await saveRegressionResult(result)
        await recordMaintenanceAction({
          action: 'check_regression',
          performedBy: adminIdentity(req),
          ok: result.ok,
          details: result,
        })
        res.json({
          ...result,
          message_sw: result.ok
            ? `Majaribio yote yamefaulu (${result.passed}/${result.total}).`
            : 'ONYO: Baadhi ya majaribio yameshindwa — kagua kabla ya kupeleka mabadiliko.',
          stderr: err ? String(stderr || '').slice(0, 800) : undefined,
        })
      } catch (e) {
        fail(res, e, 'check-regression')
      }
    },
  )
})

/** ▶ Pakua Ripoti — downloadable full JSON report. */
systemHealthAdminRouter.get('/report', async (req, res) => {
  try {
    const [snapshot, alerts, audits, maintenance] = await Promise.all([
      getSystemHealthSnapshot(),
      listHealthAlerts({ limit: 100 }),
      listAuditHistory({ range: String(req.query.range || 'month'), limit: 200 }),
      listMaintenanceHistory({ limit: 100 }),
    ])
    const report = {
      title: 'Ripoti ya Kituo cha Afya ya Mfumo — Osmani TV',
      generated_at: new Date().toISOString(),
      snapshot,
      alerts,
      audit_history: audits,
      maintenance_history: maintenance,
    }
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Content-Disposition', `attachment; filename="system-health-report-${Date.now()}.json"`)
    res.json(report)
  } catch (e) {
    fail(res, e, 'report')
  }
})
