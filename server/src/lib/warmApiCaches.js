/**
 * Preload hot read caches on VPS startup (update-check, verify modes).
 */
import { getPool } from '../db/pool.js'

export async function warmApiCaches() {
  const pool = getPool()
  if (!pool) {
    console.warn('[warm-cache] skipped — no DATABASE_URL')
    return { ok: false, reason: 'no_pool' }
  }
  const t0 = Date.now()
  try {
    const { ensureBillingStorage } = await import('../billingStore.js')
    await ensureBillingStorage()
    const { loadAppUpdatePublicPayload } = await import('../routes/appUpdate.js')
    const { loadGlobalAppModesPayload } = await import('../routes/globalAppSettings.js')
    await Promise.all([
      loadAppUpdatePublicPayload(0, 0),
      loadGlobalAppModesPayload(),
      import('../billingStore.js').then((m) => m.listActivePlansForVerify()),
    ])
    const ms = Date.now() - t0
    console.log('[warm-cache] app_update + global_modes + plans preloaded', { ms })
    return { ok: true, ms }
  } catch (e) {
    console.warn('[warm-cache] failed:', e?.message || e)
    return { ok: false, reason: String(e?.message || e) }
  }
}
