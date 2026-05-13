import { Router } from 'express'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'

/**
 * Public, read-only runtime flags (no secrets). Lets Android (and optional web) clients poll
 * across instances without admin auth; PUT /settings remains protected.
 */
export const runtimePublicRouter = Router()

runtimePublicRouter.get('/app-modes', async (_req, res) => {
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
