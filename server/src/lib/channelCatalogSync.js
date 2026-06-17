import { liveSyncBus } from './liveSyncBus.js'
import { invalidateApiCacheNamespace } from './apiResponseCache.js'
import { loadGlobalAppModesPayload } from '../routes/globalAppSettings.js'

/** Purge catalog + version poll caches so accessType changes are visible on next GET. */
export function invalidateChannelCatalogCaches() {
  invalidateApiCacheNamespace('channels')
  invalidateApiCacheNamespace('runtime-app-modes')
}

/**
 * After channel catalog writes: purge caches, bump config version, and attach `modes` so
 * subscription-stream `modeSyncHandler` pushes a fresh `v` without editing subscription.js.
 */
export async function publishChannelCatalogChange(action, channelId = null, extra = {}) {
  invalidateChannelCatalogCaches()
  const modesPayload = await loadGlobalAppModesPayload()
  liveSyncBus.publish('config.channels_changed', {
    topics: ['config'],
    action,
    channelId,
    ...extra,
    modes: {
      free_mode: modesPayload.free_mode === true,
      emergency_mode: modesPayload.emergency_mode === true,
      maintenance_mode: modesPayload.maintenance_mode === true,
    },
    synced_at: new Date().toISOString(),
  })
}
