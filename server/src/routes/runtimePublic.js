import { Router } from 'express'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { apiResponseCacheNamespace } from '../middleware/apiResponseCache.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { getCdnHealthSnapshot } from '../lib/cdnAssets.js'
import { getDatabaseUrlFingerprint, getServerGitCommit } from '../lib/deployMeta.js'
import { getPool } from '../db/pool.js'
import { UPLOADS_DIR } from '../multerUpload.js'
import fs from 'node:fs'

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
runtimePublicRouter.get('/app-update', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    const snap = liveSyncBus.snapshot()
    res.json(await loadAppUpdatePublicPayload(snap.configVersion))
  } catch (e) {
    console.error('[runtime/app-update]', e)
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
    })
  } catch (e) {
    console.error('[runtime/cutover-status]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
