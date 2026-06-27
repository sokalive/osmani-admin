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

/** Bounded batch repair — avoids nginx 504 on full restore (call until remaining=0). */
runtimePublicRouter.post('/subscription-shadow-repair-batch', requireLegacyAdminToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const { runDirectShadowRepairBatch } = await import('../lib/subscriptionShadowRepairBatch.js')
    const shadowLimit = Number(req.query.shadow_limit ?? req.query.limit ?? 10)
    const orphanLimit = Number(req.query.orphan_limit ?? 5)
    const report = await runDirectShadowRepairBatch({ shadowLimit, orphanLimit })
    res.json({ ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-shadow-repair-batch]', e)
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
    const maxRepairs = Number(req.query.max_repairs ?? 100)
    const report = await repairSubscriptionExpiryOverCredits({ dryRun, maxRepairs })
    res.json({ ok: true, ...report, commit: getServerGitCommit() })
  } catch (e) {
    console.error('[runtime/subscription-expiry-repair]', e)
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
    const mig = await migrateSubscriptionFromSourceDevice(target, source)
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

/** Payment activation timing stats from completed transactions (last 7 days). */
runtimePublicRouter.get('/payment-activation-stats', requireLegacyAdminToken, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS completed_count,
         COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))), 0)::float AS avg_activation_seconds,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))), 0)::float AS median_activation_seconds
       FROM transactions
       WHERE status = 'completed'
         AND plan_id IS NOT NULL
         AND created_at > now() - interval '7 days'`,
    )
    res.json({
      ok: true,
      commit: getServerGitCommit(),
      audit_version: 1,
      window_days: 7,
      completed_count: rows[0]?.completed_count ?? 0,
      payment_activation_average_seconds: Number(rows[0]?.avg_activation_seconds ?? 0).toFixed(2),
      payment_activation_median_seconds: Number(rows[0]?.median_activation_seconds ?? 0).toFixed(2),
    })
  } catch (e) {
    console.error('[runtime/payment-activation-stats]', e)
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
