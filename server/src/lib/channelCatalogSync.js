import { liveSyncBus } from './liveSyncBus.js'
import { invalidateApiCacheNamespace } from './apiResponseCache.js'
import { loadGlobalAppModesPayload } from '../routes/globalAppSettings.js'
import { invalidateChannelIdNameMapCache, getChannelById } from '../store.js'

/** Purge catalog + version poll caches so accessType changes are visible on next GET. */
export function invalidateChannelCatalogCaches() {
  invalidateApiCacheNamespace('channels')
  invalidateApiCacheNamespace('runtime-app-modes')
  invalidateChannelIdNameMapCache()
}

/**
 * After channel catalog writes: purge caches, bump config version, and attach `modes` so
 * subscription-stream `modeSyncHandler` pushes a fresh `v` without editing subscription.js.
 */
export async function publishChannelCatalogChange(action, channelId = null, extra = {}) {
  invalidateChannelCatalogCaches()
  const modesPayload = await loadGlobalAppModesPayload()
  let channelPatch = null
  const cid = channelId != null ? Number(channelId) : null
  if (cid != null && Number.isFinite(cid)) {
    try {
      const row = await getChannelById(cid)
      if (row) {
        channelPatch = {
          id: row.id,
          access_type: row.accessType === 'premium' ? 'premium' : 'free',
          accessType: row.accessType === 'premium' ? 'premium' : 'free',
          is_active: row.isActive !== false,
          show_in_app: row.showInApp !== false,
          updated_at: new Date().toISOString(),
        }
      }
    } catch {
      /* optional patch */
    }
  }
  const catalogRevision = Date.now()
  liveSyncBus.publish('config.channels_changed', {
    topics: ['config'],
    action,
    channelId,
    channel: channelPatch,
    catalog_revision: catalogRevision,
    ...extra,
    modes: {
      free_mode: modesPayload.free_mode === true,
      emergency_mode: modesPayload.emergency_mode === true,
      maintenance_mode: modesPayload.maintenance_mode === true,
    },
    synced_at: new Date().toISOString(),
  })
}
