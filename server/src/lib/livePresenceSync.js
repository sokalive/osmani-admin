import * as billing from '../billingStore.js'
import { resolveLocationLabel } from './analyticsLocation.js'
import { parseChannelRefFromRequest, parseChannelClearFromPayload } from './analyticsPresence.js'
import { getLiveChannelHint } from './liveChannelHint.js'
import { publishAfterLivePresenceUpsert } from './presenceEventPublish.js'
import { canPublishOrdinaryTelemetry } from './telemetryAdmission.js'

/**
 * Upsert live_sessions from an HTTP request, then publish analytics SSE (after DB write).
 * Ordinary same-state heartbeats are coalesced / pressure-suppressed; meaningful
 * channel/online transitions publish analytics.presence_changed immediately.
 */
export async function syncLivePresenceFromRequest(
  req,
  deviceId,
  { event = 'analytics.session_heartbeat' } = {},
) {
  const d = String(deviceId ?? '').trim()
  if (!d) return null

  const merged = {
    ...(req?.query && typeof req.query === 'object' ? req.query : {}),
    ...(req?.body && typeof req.body === 'object' ? req.body : {}),
  }
  const channelRef = parseChannelRefFromRequest(req)
  const hint = getLiveChannelHint(d)
  const clearChannel = parseChannelClearFromPayload(merged) || hint?.clearChannel === true
  // Skip expensive geo work on routine heartbeats when pool is already pressured.
  // Channel/open transitions still resolve location when possible.
  const hasChannelSignal =
    clearChannel ||
    Boolean(channelRef.channelId || channelRef.channelName || hint?.channelId || hint?.channelName)
  let country = null
  if (hasChannelSignal || canPublishOrdinaryTelemetry()) {
    country = await resolveLocationLabel(req?.body, req)
  }

  const touch = await billing.touchLivePresence({
    deviceId: d,
    country,
    channelId: channelRef.channelId || hint?.channelId || null,
    channelName: channelRef.channelName || hint?.channelName || null,
    clearChannel,
    installBody: req?.body,
  })

  return publishAfterLivePresenceUpsert(d, touch, { event })
}
