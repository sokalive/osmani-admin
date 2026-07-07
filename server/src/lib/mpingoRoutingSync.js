import { liveSyncBus } from './liveSyncBus.js'
import { invalidateChannelCatalogCaches, publishChannelCatalogChange } from './channelCatalogSync.js'

/** Bump when Mpingo effective player routing logic changes (apps compare via header/SSE). */
export const MPINGO_ROUTING_EPOCH = Math.max(
  1,
  Number(process.env.MPINGO_ROUTING_EPOCH) || 2,
)

let startupPublished = false

export function publishMpingoRoutingConfigSync(reason = 'mpingo_routing_deploy') {
  void publishChannelCatalogChange('routing_refresh', null, {
    routing_epoch: MPINGO_ROUTING_EPOCH,
    reason,
  }).catch((err) => {
    console.error('[mpingo-routing] catalog sync publish failed:', err)
    invalidateChannelCatalogCaches()
    liveSyncBus.publish('config.channels_changed', {
      topics: ['config'],
      action: 'routing_refresh',
      routing_epoch: MPINGO_ROUTING_EPOCH,
      reason,
      synced_at: new Date().toISOString(),
    })
  })
}

/** Once per process: notify connected apps to refetch /api/channels after routing deploy. */
export function ensureMpingoRoutingStartupSync() {
  if (startupPublished) return
  startupPublished = true
  publishMpingoRoutingConfigSync('mpingo_routing_startup')
}

export function applyChannelsRoutingHeaders(res) {
  const snap = liveSyncBus.snapshot()
  res.setHeader('X-Channels-Routing-Epoch', String(MPINGO_ROUTING_EPOCH))
  res.setHeader('X-Config-Version', String(snap.configVersion))
  res.setHeader('X-Catalog-Revision', String(snap.configVersion))
}
