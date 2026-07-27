import * as billing from '../billingStore.js'
import { resolveLocationLabel } from './analyticsLocation.js'
import { parseChannelRefFromRequest, parseChannelClearFromPayload } from './analyticsPresence.js'
import { getLiveChannelHint } from './liveChannelHint.js'
import { liveSyncBus } from './liveSyncBus.js'

/**
 * Upsert live_sessions from an HTTP request, then publish analytics SSE (after DB write).
 */
export async function syncLivePresenceFromRequest(
  req,
  deviceId,
  { event = 'analytics.session_heartbeat' } = {},
) {
  const d = String(deviceId ?? '').trim()
  if (!d) return null

  const merged = { ...(req?.query && typeof req.query === 'object' ? req.query : {}), ...(req?.body && typeof req.body === 'object' ? req.body : {}) }
  const channelRef = parseChannelRefFromRequest(req)
  const hint = getLiveChannelHint(d)
  const clearChannel = parseChannelClearFromPayload(merged) || hint?.clearChannel === true
  const country = await resolveLocationLabel(req?.body, req)

  await billing.touchLivePresence({
    deviceId: d,
    country,
    channelId: channelRef.channelId || hint?.channelId || null,
    channelName: channelRef.channelName || hint?.channelName || null,
    clearChannel,
    installBody: req?.body,
  })
  liveSyncBus.publish(event, { topics: ['analytics'], deviceId: d })
  return { deviceId: d }
}
