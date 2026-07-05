import { Router } from 'express'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { apiResponseCacheNamespace } from '../middleware/apiResponseCache.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'
import { extractVersionCodeFromRequest } from '../lib/clientApiTelemetry.js'
import { parseVersionCode, APP_UPDATE_NEVER_MIN } from '../lib/appUpdateTargeting.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { getCdnHealthSnapshot } from '../lib/cdnAssets.js'
import { getDatabaseUrlFingerprint, getServerGitCommit } from '../lib/deployMeta.js'
import { getLoadedEnvPaths } from '../loadEnv.js'
import { getPool } from '../db/pool.js'
import { UPLOADS_DIR } from '../multerUpload.js'
import { statPathDiskUsage } from '../lib/uploadDiskSafety.js'
import {
  cleanupDisposableUploadArtifacts,
  collectUploadStorageForensics,
} from '../lib/uploadStorageForensics.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runSubscriptionRestorationAudit } from '../lib/subscriptionRestorationAudit.js'
import { runVpsMigrationAudit } from '../lib/vpsMigrationAudit.js'

function legacyAdminTokenOk(req) {
  const expected = String(process.env.APP_UPDATE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
  if (!expected) return false
  const got = String(req.headers['x-admin-token'] ?? '').trim()
  return got === expected
}

function requireLegacyAdminToken(req, res, next) {
  if (legacyAdminTokenOk(req)) return next()
  return res.status(403).json({ ok: false, error: 'Invalid admin token' })
}

/**
 * Public, read-only runtime flags (no secrets). Lets Android (and optional web) clients poll
 * across instances without admin auth; PUT /settings remains protected.
 */
export const runtimePublicRouter = Router()

runtimePublicRouter.get('/trial-watch', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    const settings = await loadTrialWatchSettings()
    const snap = liveSyncBus.snapshot()
    res.json(trialWatchSettingsToPublicPayload(settings, snap.configVersion))
  } catch (e) {
    console.error('[runtime/trial-watch]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

runtimePublicRouter.get('/app-modes', apiResponseCacheNamespace('runtime-app-modes'), async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    const payload = await loadGlobalAppModesPayload()
    res.json(payload)
  } catch (e) {
    console.error('[runtime/app-modes]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Public OTA app-update flags (installer soft/force/auto-download, APK URL/hash). Same shape as /update-check. */
runtimePublicRouter.get('/app-update', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    const snap = liveSyncBus.snapshot()
    const clientVersion = extractVersionCodeFromRequest(req)
    res.json(await loadAppUpdatePublicPayload(snap.configVersion, clientVersion))
  } catch (e) {
    console.error('[runtime/app-update]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/**
 * Account screen update metadata — additive; does not change popup force/soft/auto behavior.
 */
runtimePublicRouter.get('/account-update', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    const snap = liveSyncBus.snapshot()
    const installedVersionCode = extractVersionCodeFromRequest(req)
    const ota = await loadAppUpdatePublicPayload(snap.configVersion, installedVersionCode)
    const latestVersionCode = parseVersionCode(ota.version_code)
    const hasNewerCatalog =
      installedVersionCode > 0 && latestVersionCode > 0 && installedVersionCode < latestVersionCode
    const updatePromptAvailable = String(ota.decision ?? 'NONE').toUpperCase() !== 'NONE'
    res.json({
      ok: true,
      v: snap.configVersion,
      installed_version_code: installedVersionCode,
      installedVersionCode,
      latest_version_code: latestVersionCode,
      latestVersionCode,
      update_available: hasNewerCatalog,
      updateAvailable: hasNewerCatalog,
      update_prompt_available: updatePromptAvailable,
      updatePromptAvailable,
      apk_url: ota.apk_url ?? '',
      apkUrl: ota.apk_url ?? '',
      apk_sha256: ota.apk_sha256 ?? '',
      playstore_url: ota.playstore_url ?? '',
      version_name: ota.version_name ?? '',
      versionName: ota.version_name ?? '',
      package_name: ota.package_name ?? '',
      decision: ota.decision ?? 'NONE',
      update_target_reason: ota.update_target_reason ?? '',
      updateTargetReason: ota.update_target_reason ?? '',
      targeting_below_v24: installedVersionCode > 0 && installedVersionCode < APP_UPDATE_NEVER_MIN,
      targeting_v24_plus: installedVersionCode >= APP_UPDATE_NEVER_MIN,
      server_time: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[runtime/account-update]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Ops cutover probe — no secrets; confirms DB/CDN/uploads/admin token wiring. */
runtimePublicRouter.get('/cutover-status', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    const pool = getPool()
    let planCount = null
    let activeDeviceSubs = null
    if (pool) {
      const plans = await pool.query(`SELECT COUNT(*)::int AS n FROM plans WHERE is_active = true`)
      planCount = plans.rows[0]?.n ?? null
      const subs = await pool.query(
        `SELECT COUNT(*)::int AS n FROM device_subscriptions WHERE expires_at > NOW()`,
      )
      activeDeviceSubs = subs.rows[0]?.n ?? null
    }
    const uploadDirExists = fs.existsSync(UPLOADS_DIR)
    let uploadFileCount = null
    if (uploadDirExists) {
      try {
        uploadFileCount = fs.readdirSync(UPLOADS_DIR).filter((f) => !f.startsWith('.')).length
      } catch {
        uploadFileCount = null
      }
    }
    const uploadDisk = statPathDiskUsage(UPLOADS_DIR)
    const adminTokenConfigured = Boolean(
      String(process.env.ADMIN_API_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '').trim(),
    )
    res.json({
      ok: true,
      server_time: new Date().toISOString(),
      commit: getServerGitCommit(),
      env_files_loaded: getLoadedEnvPaths(),
      database_url_configured: Boolean(String(process.env.DATABASE_URL || '').trim()),
      database: getDatabaseUrlFingerprint(),
      pool_ready: Boolean(pool),
      plan_count: planCount,
      active_device_subscriptions: activeDeviceSubs,
      cdn: getCdnHealthSnapshot(),
      uploads_dir: UPLOADS_DIR,
      uploads_dir_exists: uploadDirExists,
      uploads_file_count: uploadFileCount,
      uploads_disk: uploadDisk.ok
        ? {
            free_bytes: uploadDisk.freeBytes,
            total_bytes: uploadDisk.totalBytes,
            used_percent: uploadDisk.usedPercent,
          }
        : { error: uploadDisk.error },
      admin_token_configured: adminTokenConfigured,
      base_url: String(process.env.BASE_URL || '').trim() || null,
      stream_api_base_url: String(process.env.STREAM_API_BASE_URL || '').trim() || null,
      admin_public_url: String(process.env.ADMIN_PUBLIC_URL || '').trim() || null,
    })
  } catch (e) {
    console.error('[runtime/cutover-status]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** VPS migration audit — versionCode × API host matrix (admin token). */
runtimePublicRouter.get('/vps-migration-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const windowDays = Number(req.query.window_days ?? req.query.days ?? 7)
    const report = await runVpsMigrationAudit({ windowDays })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/vps-migration-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Full production device investigation (read-only SQL + access state). */
runtimePublicRouter.get('/device-production-investigation', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const deviceId = String(req.query.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const { runDeviceProductionInvestigation } = await import('../lib/deviceProductionInvestigation.js')
    const report = await runDeviceProductionInvestigation(deviceId)
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/device-production-investigation]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Repair false-expired for one device if eligible. */
runtimePublicRouter.post('/device-production-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(req.query.device_id ?? b.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const { repairDeviceIfEligible } = await import('../lib/deviceProductionInvestigation.js')
    const report = await repairDeviceIfEligible(deviceId)
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/device-production-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Read-only exact SQL subscription incident statistics. */
runtimePublicRouter.get('/subscription-incident-database-report', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionIncidentDatabaseReport } = await import('../lib/subscriptionIncidentDatabaseReport.js')
    const report = await runSubscriptionIncidentDatabaseReport()
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-incident-database-report]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Read-only manual gift false-positive audit (SQL evidence). */
runtimePublicRouter.get('/manual-gift-database-report', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runManualGiftDatabaseReport } = await import('../lib/manualGiftAudit.js')
    const report = await runManualGiftDatabaseReport()
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/manual-gift-database-report]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Production payment audit (90-day SQL evidence). */
runtimePublicRouter.get('/payment-production-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const days = Number(req.query.days ?? 90)
    const { runPaymentProductionAudit } = await import('../lib/paymentProductionAudit.js')
    const report = await runPaymentProductionAudit({ days })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/payment-production-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** SonicPesa payment reliability metrics (webhook age, inbox, stale pending, latency). */
runtimePublicRouter.get('/sonicpesa-reliability-metrics', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const days = Number(req.query.days ?? 30)
    const { runSonicpesaReliabilityMetrics } = await import('../lib/sonicpesaReliabilityMetrics.js')
    const { getPool } = await import('../db/pool.js')
    const pool = getPool()
    const poolSnap = pool
      ? {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
          max: pool.options?.max ?? null,
        }
      : null
    const metrics = await runSonicpesaReliabilityMetrics({ days })
    res.json({ ok: true, ...metrics, pool: poolSnap, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/sonicpesa-reliability-metrics]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Dry-run classify stale SonicPesa pending orders (no mutation unless dry_run=0). */
runtimePublicRouter.post('/sonicpesa-reconcile-stale-pending', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '1').trim() !== '0'
    const limit = Number(req.query.limit ?? b.limit ?? 50)
    const staleMinutes = Number(req.query.stale_min ?? b.stale_min ?? 30)
    const { runStaleSonicpesaPendingReconcile } = await import('../lib/sonicpesaStalePendingReconcile.js')
    const out = await runStaleSonicpesaPendingReconcile({ dryRun, limit, staleMinutes })
    res.json({ ok: true, ...out, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/sonicpesa-reconcile-stale-pending]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** SonicPesa webhook readiness — callback contract for owner dashboard + engineering verification. */
runtimePublicRouter.get('/sonicpesa-webhook-readiness', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { getSonicpesaWebhookHealthSnapshot } = await import('../lib/sonicpesaWebhookHealth.js')
    const { getInboxMetrics } = await import('../lib/sonicpesaWebhookInbox.js')
    const { getPoolStats } = await import('../db/pool.js')
    const health = await getSonicpesaWebhookHealthSnapshot()
    const inbox = await getInboxMetrics()
    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      commit: getServerGitCommit(),
      webhook: health,
      inbox,
      pool: getPoolStats(),
      osmani_endpoint_ready: true,
      provider_endpoint_configured: health?.last_provider_webhook_at != null,
    })
  } catch (e) {
    console.error('[runtime/sonicpesa-webhook-readiness]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Repair critical unresolved completed SonicPesa rows (canonical activation only). */
runtimePublicRouter.post('/sonicpesa-repair-critical-unresolved', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '0').trim() === '1'
    const { repairCriticalUnresolvedCompleted } = await import('../lib/sonicpesaStalePendingReconcile.js')
    const out = await repairCriticalUnresolvedCompleted({ dryRun })
    res.json({ ok: true, ...out, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/sonicpesa-repair-critical-unresolved]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Full read-only manual gift production investigation (exact PostgreSQL). */
runtimePublicRouter.get('/manual-gift-production-investigation', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runManualGiftProductionInvestigation } = await import('../lib/manualGiftAudit.js')
    const report = await runManualGiftProductionInvestigation()
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/manual-gift-production-investigation]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Acknowledge stale pending manual grants (grants table only — no subscription mutation). */
runtimePublicRouter.post('/manual-gift-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '').trim() === '1'
    const { repairStaleManualGiftAcknowledgements } = await import('../lib/manualGiftAudit.js')
    const out = await repairStaleManualGiftAcknowledgements({ dryRun })
    res.json({ ok: true, ...out, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/manual-gift-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Acknowledge obsolete testing-device grants only. */
runtimePublicRouter.post('/manual-gift-repair-testing', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '').trim() === '1'
    const { repairObsoleteTestingManualGrants } = await import('../lib/manualGiftAudit.js')
    const out = await repairObsoleteTestingManualGrants({ dryRun })
    res.json({ ok: true, ...out, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/manual-gift-repair-testing]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Read-only subscription restoration audit (admin token). */
runtimePublicRouter.get('/subscription-restoration-audit', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const report = await runSubscriptionRestorationAudit({ repair: false })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-restoration-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Safe repair: backfill fingerprints, recover migration shadows, finalize orphan activations. */
runtimePublicRouter.post('/subscription-restoration-repair', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const report = await runSubscriptionRestorationAudit({ repair: true })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-restoration-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Audit transfer sources that incorrectly remain active; optional repair. */
runtimePublicRouter.get('/transfer-source-revocation-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { auditTransferSourceRevocation } = await import('../lib/transferRevocationGuard.js')
    const repair = String(req.query.repair ?? '').trim() === '1'
    const report = await auditTransferSourceRevocation({ repair })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/transfer-source-revocation-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

runtimePublicRouter.post('/transfer-source-revocation-repair', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { auditTransferSourceRevocation } = await import('../lib/transferRevocationGuard.js')
    const report = await auditTransferSourceRevocation({ repair: true })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/transfer-source-revocation-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Read-only incident audit (suspended/revoked shadows + restoration counts). */
runtimePublicRouter.get('/subscription-incident-audit', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionIncidentAudit } = await import('../lib/subscriptionIncidentAudit.js')
    const report = await runSubscriptionIncidentAudit({ repair: false })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-incident-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Repair wrongly denied paid users + migration shadows. */
runtimePublicRouter.post('/subscription-incident-repair', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionIncidentAudit } = await import('../lib/subscriptionIncidentAudit.js')
    const report = await runSubscriptionIncidentAudit({ repair: true, reconcileBlocks: true })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-incident-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Audit future-expiry rows wrongly marked inactive (read-only). */
runtimePublicRouter.get('/subscription-false-expired-audit', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { findFalseExpiredSubscriptions } = await import('../lib/subscriptionFalseExpiredRepair.js')
    const report = await findFalseExpiredSubscriptions()
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-false-expired-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Restore ACTIVE for future-expiry rows stuck non-active. Never shortens expires_at. */
runtimePublicRouter.post('/subscription-false-expired-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { repairFalseExpiredSubscriptions } = await import('../lib/subscriptionFalseExpiredRepair.js')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '1').trim() !== '0'
    const confirm = String(req.query.confirm ?? b.confirm ?? '0').trim() === '1'
    const report = await repairFalseExpiredSubscriptions({ dryRun, confirm })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-false-expired-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Audit moved:* devices that lost active sub to a same-phone sibling (wrong migration direction). */
runtimePublicRouter.get('/subscription-wrong-direction-audit', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { findWrongDirectionMigrationVictims, countDeniedFutureEntitlement } = await import(
      '../lib/subscriptionWrongDirectionRepair.js'
    )
    const victims = await findWrongDirectionMigrationVictims()
    const counts = await countDeniedFutureEntitlement()
    res.json({
      ok: true,
      victims_count: victims.length,
      counts,
      victims: victims.slice(0, 100),
      commit: getServerGitCommit(),
    })
  } catch (e) {
    console.error('[runtime/subscription-wrong-direction-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Reclaim subscription onto user's current device_id from same-phone active sibling. */
runtimePublicRouter.post('/subscription-wrong-direction-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { repairWrongDirectionMigrations } = await import('../lib/subscriptionWrongDirectionRepair.js')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '1').trim() !== '0'
    const confirm = String(req.query.confirm ?? b.confirm ?? '0').trim() === '1'
    const limit = Number(req.query.limit ?? b.limit ?? 50)
    const report = await repairWrongDirectionMigrations({ dryRun, confirm, limit })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-wrong-direction-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Full DB vs verify/status/admin parity audit (read-only). */
runtimePublicRouter.get('/subscription-api-parity-audit', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionApiParityAudit } = await import('../lib/subscriptionApiParityAudit.js')
    const report = await runSubscriptionApiParityAudit()
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-api-parity-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Consolidate duplicate active subscriptions on the same payment phone. */
runtimePublicRouter.post('/subscription-duplicate-phone-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { repairDuplicatePhoneClusters } = await import('../lib/subscriptionApiParityAudit.js')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '1').trim() !== '0'
    const confirm = String(req.query.confirm ?? b.confirm ?? '0').trim() === '1'
    const report = await repairDuplicatePhoneClusters({ dryRun, confirm })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-duplicate-phone-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Run false-expired + wrong-direction + duplicate-phone + shadow repair until clear. */
runtimePublicRouter.post('/subscription-api-parity-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runFullSubscriptionParityRepair } = await import('../lib/subscriptionApiParityAudit.js')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const confirm = String(req.query.confirm ?? b.confirm ?? '0').trim() === '1'
    const maxRounds = Number(req.query.max_rounds ?? b.max_rounds ?? 10)
    const report = await runFullSubscriptionParityRepair({ confirm, maxRounds })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-api-parity-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Bounded batch repair — avoids nginx 504 on full restore (call until remaining=0). */
runtimePublicRouter.post('/subscription-shadow-repair-batch', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runDirectShadowRepairBatch, runDirectShadowRepairUntilZero } = await import(
      '../lib/subscriptionShadowRepairBatch.js'
    )
    const untilZero = String(req.query.until_zero ?? req.query.untilZero ?? '').trim() === '1'
    const shadowLimit = Number(req.query.shadow_limit ?? req.query.limit ?? 10)
    const orphanLimit = Number(req.query.orphan_limit ?? 5)
    const report = untilZero
      ? await runDirectShadowRepairUntilZero({ shadowLimit, orphanLimit })
      : await runDirectShadowRepairBatch({ shadowLimit, orphanLimit })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-shadow-repair-batch]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Phone → active subscription ownership audit (read-only). */
runtimePublicRouter.get('/phone-subscription-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const phone = String(req.query.phone ?? req.query.payment_phone ?? '').trim()
    if (!phone) {
      return res.status(400).json({ ok: false, error: 'phone query parameter is required' })
    }
    const deviceId = String(req.query.device_id ?? '').trim()
    const { auditPhoneSubscriptionOwnership } = await import('../lib/phoneSubscriptionGuard.js')
    const report = await auditPhoneSubscriptionOwnership(phone, { deviceId: deviceId || undefined })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/phone-subscription-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Package duration + expiry stacking audit (read-only). */
runtimePublicRouter.get('/subscription-expiry-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionExpiryAudit } = await import('../lib/subscriptionExpiryAudit.js')
    const limit = Number(req.query.limit ?? 2000)
    const sinceDays = Number(req.query.since_days ?? req.query.days ?? 90)
    const deviceId = String(req.query.device_id ?? '').trim()
    const report = await runSubscriptionExpiryAudit({
      limit,
      sinceDays,
      deviceId: deviceId || undefined,
    })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-expiry-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Repair over-credited subscriptions (>1 day beyond payment replay). ?dry_run=0 to apply. */
runtimePublicRouter.post('/subscription-expiry-repair', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { repairSubscriptionExpiryOverCredits } = await import('../lib/subscriptionExpiryAudit.js')
    const dryRun = String(req.query.dry_run ?? '1').trim() !== '0'
    const confirm = String(req.query.confirm ?? req.body?.confirm ?? '0').trim() === '1'
    const maxRepairs = Number(req.query.max_repairs ?? 50)
    const offset = Number(req.query.offset ?? 0)
    const report = await repairSubscriptionExpiryOverCredits({ dryRun, maxRepairs, offset, confirm })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-expiry-repair]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Audit users wrongly inactive after expiry repair (read-only). */
runtimePublicRouter.get('/subscription-expiry-restore-audit', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { findPaymentReplayRestoreCandidates, runSubscriptionExpiryRestore } = await import(
      '../lib/subscriptionExpiryRestore.js'
    )
    const sinceDays = Number(req.query.since_days ?? req.query.days ?? 30)
    const deviceId = String(req.query.device_id ?? '').trim()
    const pool = (await import('../db/pool.js')).getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const victims = await findPaymentReplayRestoreCandidates(pool, { sinceDays })
    const dryReport = await runSubscriptionExpiryRestore({
      dryRun: true,
      sinceDays,
      deviceId: deviceId || undefined,
      maxRestores: 500,
    })
    res.json({
      ok: true,
      since_days: sinceDays,
      replay_victims: deviceId ? victims.filter((v) => v.device_id === deviceId) : victims,
      migration_shadows: dryReport.migration_shadows_found,
      would_restore: dryReport.restored_count,
      samples: dryReport.restored.slice(0, 25),
      commit: getServerGitCommit(),
    })
  } catch (e) {
    console.error('[runtime/subscription-expiry-restore-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Safe restore: replay payments + migration shadows. Never reduces expiry. ?dry_run=0 to apply. */
runtimePublicRouter.post('/subscription-expiry-restore', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runSubscriptionExpiryRestore } = await import('../lib/subscriptionExpiryRestore.js')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const dryRun = String(req.query.dry_run ?? b.dry_run ?? '1').trim() !== '0'
    const sinceDays = Number(req.query.since_days ?? b.since_days ?? 30)
    const maxRestores = Number(req.query.max_restores ?? b.max_restores ?? 200)
    const deviceId = String(req.query.device_id ?? b.device_id ?? '').trim()
    const report = await runSubscriptionExpiryRestore({
      dryRun,
      sinceDays,
      maxRestores,
      deviceId: deviceId || undefined,
    })
    res.json({ ok: report.unresolved.length === 0, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-expiry-restore]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Directed single-pair migration (telemetry-aware recovery; avoids install_instance ping-pong). */
runtimePublicRouter.post('/subscription-shadow-migrate', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const target = String(b.target_device_id ?? b.target ?? req.query.target ?? '').trim()
    const source = String(b.source_device_id ?? b.source ?? req.query.source ?? '').trim()
    if (!target || !source) {
      return res.status(400).json({ ok: false, error: 'target_device_id and source_device_id are required' })
    }
    const { migrateSubscriptionFromSourceDevice } = await import('../lib/subscriptionRecovery.js')
    const { getDeviceSubscriptionAccessState } = await import('../billingStore.js')
    const probe = async (deviceId) => {
      const row = await getDeviceSubscriptionAccessState(deviceId, null)
      return row?.active_now === true && row?.blocked_now !== true
    }
    if (await probe(target)) {
      return res.json({ ok: true, skipped: 'target_already_active', target, source, commit: getServerGitCommit() })
    }
    if (!(await probe(source))) {
      return res.status(409).json({ ok: false, error: 'source_not_active', target, source })
    }
    const mig = await migrateSubscriptionFromSourceDevice(target, source, null, {
      allowReverseTransfer: Boolean(b.allow_reverse_transfer ?? b.allowReverseTransfer),
    })
    const verifyActive = await probe(target)
    res.json({
      ok: mig.recovered === true && verifyActive,
      target,
      source,
      recovered: mig.recovered === true,
      verify_active: verifyActive,
      commit: getServerGitCommit(),
    })
  } catch (e) {
    console.error('[runtime/subscription-shadow-migrate]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Backfill empty transactions.phone from raw_payload (admin repair). */
runtimePublicRouter.post('/backfill-transaction-phones', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const apply = String(req.query.apply ?? b.apply ?? '0').trim() === '1'
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? b.limit ?? 200)))
    const { rows } = await pool.query(
      `SELECT order_id, device_id, phone, raw_payload, status, created_at
       FROM transactions
       WHERE plan_id IS NOT NULL AND trim(coalesce(phone::text, '')) = ''
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    )
    const { phoneFromTransactionRow, normalizePhoneDigits, backfillTransactionPhoneIfMissing } =
      await import('../billingStore.js')
    const candidates = []
    for (const r of rows) {
      const inferred = phoneFromTransactionRow(r)
      const digits = normalizePhoneDigits(inferred)
      if (!digits || digits.length < 10) continue
      candidates.push({
        order_id: String(r.order_id ?? ''),
        device_id: r.device_id != null ? String(r.device_id) : '',
        phone: /^255\d{9}$/.test(digits) ? `+${digits}` : inferred,
        status: String(r.status ?? ''),
      })
    }
    let updated = 0
    if (apply) {
      for (const c of candidates) {
        const row = await backfillTransactionPhoneIfMissing(c.order_id, c.phone)
        if (row && String(row.phone ?? '').trim()) updated += 1
      }
    }
    res.json({
      ok: true,
      commit: getServerGitCommit(),
      dry_run: !apply,
      scanned: rows.length,
      candidates: candidates.length,
      updated,
      sample: candidates.slice(0, 15),
    })
  } catch (e) {
    console.error('[runtime/backfill-transaction-phones]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Payment activation timing stats from completed transactions (last 7 days). */
runtimePublicRouter.get('/payment-activation-stats', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS completed_count,
         COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))), 0)::float AS avg_checkout_to_complete_seconds,
         COALESCE(
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))),
           0
         )::float AS median_checkout_to_complete_seconds,
         COALESCE(AVG(server_activation_seconds), 0)::float AS avg_server_activation_seconds,
         COALESCE(
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY server_activation_seconds),
           0
         )::float AS median_server_activation_seconds
       FROM (
         SELECT
           t.created_at,
           t.updated_at,
           GREATEST(
             0,
             EXTRACT(EPOCH FROM (ds.updated_at - t.updated_at))
           )::float AS server_activation_seconds
         FROM transactions t
         INNER JOIN device_subscriptions ds
           ON ds.device_id = t.device_id
          AND ds.transaction_id = t.order_id
         WHERE t.status = 'completed'
           AND t.plan_id IS NOT NULL
           AND t.created_at > now() - interval '7 days'
           AND ds.status = 'active'
           AND ds.updated_at >= t.updated_at
           AND ds.updated_at <= t.updated_at + interval '5 seconds'
       ) s`,
    )
    const medianServer = Number(rows[0]?.median_server_activation_seconds ?? 0)
    const medianCheckout = Number(rows[0]?.median_checkout_to_complete_seconds ?? 0)
    res.json({
      ok: true,
      commit: getServerGitCommit(),
      audit_version: 2,
      window_days: 7,
      completed_count: rows[0]?.completed_count ?? 0,
      payment_activation_average_seconds: Number(rows[0]?.avg_checkout_to_complete_seconds ?? 0).toFixed(2),
      payment_activation_median_seconds: medianCheckout.toFixed(2),
      checkout_to_complete_median_seconds: medianCheckout.toFixed(2),
      server_activation_average_seconds: Number(rows[0]?.avg_server_activation_seconds ?? 0).toFixed(2),
      server_activation_median_seconds: medianServer.toFixed(2),
    })
  } catch (e) {
    console.error('[runtime/payment-activation-stats]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** VPS disk / upload storage forensics (admin token). Read-only. */
runtimePublicRouter.get('/storage-forensics', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const report = await collectUploadStorageForensics()
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/storage-forensics]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Remove only disposable upload probes/temp files (admin token). ?apply=1 to delete. */
runtimePublicRouter.post('/storage-cleanup-disposable', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const apply = String(req.query.apply ?? b.apply ?? '0').trim() === '1'
    const before = await collectUploadStorageForensics()
    if (!apply) {
      const preview = await cleanupDisposableUploadArtifacts({ dryRun: true })
      return res.json({
        ok: true,
        dry_run: true,
        commit: getServerGitCommit(),
        before_disk: before.disk_bytes,
        would_remove_count: preview.removed_count,
        would_reclaim_bytes: preview.reclaimed_bytes,
        sample: preview.removed,
      })
    }
    const afterCleanup = await cleanupDisposableUploadArtifacts({ dryRun: false })
    const after = await collectUploadStorageForensics()
    res.json({
      ok: true,
      dry_run: false,
      commit: getServerGitCommit(),
      before_disk: before.disk_bytes,
      after_disk: after.disk_bytes,
      cleanup: afterCleanup,
    })
  } catch (e) {
    console.error('[runtime/storage-cleanup-disposable]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Reload nginx from repo snippets (admin token). Applies /uploads routing fixes without full cutover. */
runtimePublicRouter.post('/reload-nginx', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const root = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
    const script = path.join(root, 'deploy/contabo/reload-osmanitv-nginx.sh')
    const raw =
      'https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/reload-osmanitv-nginx.sh'
    const env = { ...process.env, OSMANI_ADMIN_ROOT: root }
    const result = fs.existsSync(script)
      ? spawnSync('bash', [script], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
      : spawnSync('bash', ['-c', `curl -fsSL "${raw}" | bash`], { env, encoding: 'utf8', timeout: 120_000 })
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    if (result.status !== 0) {
      return res.status(500).json({
        ok: false,
        error: 'reload-nginx failed',
        exit_code: result.status ?? 1,
        output: output.slice(-8000),
      })
    }
    res.json({ ok: true, commit: getServerGitCommit(), output: output.slice(-8000) })
  } catch (e) {
    console.error('[runtime/reload-nginx]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Provision branded HTTPS on VPS (admin token). Does not affect Render. */
runtimePublicRouter.post('/provision-https', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const root = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
    const script = path.join(root, 'deploy/contabo/fix-osmanitv-https.sh')
    const raw =
      'https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/fix-osmanitv-https.sh'
    const env = {
      ...process.env,
      OSMANI_ADMIN_ROOT: root,
      CERTBOT_EMAIL: String(process.env.CERTBOT_EMAIL || 'admin@osmanitv.com').trim(),
    }
    const result = fs.existsSync(script)
      ? spawnSync('bash', [script], { cwd: root, env, encoding: 'utf8', timeout: 600_000 })
      : spawnSync('bash', ['-c', `curl -fsSL "${raw}" | bash`], { env, encoding: 'utf8', timeout: 600_000 })
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    if (result.status !== 0) {
      return res.status(500).json({
        ok: false,
        error: 'provision-https failed',
        exit_code: result.status ?? 1,
        output: output.slice(-8000),
      })
    }
    res.json({ ok: true, commit: getServerGitCommit(), output: output.slice(-8000) })
  } catch (e) {
    console.error('[runtime/provision-https]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
