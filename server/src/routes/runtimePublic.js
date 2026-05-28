import { Router } from 'express'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { apiResponseCacheNamespace } from '../middleware/apiResponseCache.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

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
