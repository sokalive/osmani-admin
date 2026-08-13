import * as billing from '../billingStore.js'
import { resolveLocationLabel } from './analyticsLocation.js'
import { parseChannelRefFromRequest, parseChannelClearFromPayload } from './analyticsPresence.js'
import { getLiveChannelHint } from './liveChannelHint.js'
import { publishAfterLivePresenceUpsert } from './presenceEventPublish.js'
import {
  canPublishOrdinaryTelemetry,
  canUseBackgroundDb,
  shouldSkipOrdinaryPresenceUpsert,
  markOrdinaryPresenceWritten,
} from './telemetryAdmission.js'

function normId(v) {
  const s = String(v ?? '').trim()
  return s || null
}

/**
 * Heuristic before DB: is this request likely a real watching/online transition?
 * Ordinary same-state TTL pings return false.
 */
export function isLikelyMeaningfulPresenceRequest(deviceId, { clearChannel, channelRef, hint, event }) {
  const eventName = String(event || 'analytics.session_heartbeat')
  if (eventName !== 'analytics.session_heartbeat') return true
  // Explicit leave/stop-watching must never be treated as ordinary TTL — skipping
  // clears under pressure leaves viewers stuck "watching" and can kick Home paths.
  if (clearChannel) return true
  const prev = normId(hint?.channelId)
  const requested = normId(channelRef?.channelId)
  if (requested && prev && requested !== prev) return true // switch
  if (requested && !prev) return true // open (or first watch signal)
  if (!requested && !clearChannel && prev) return false // ordinary keep-watching ping
  if (!requested && !clearChannel && !prev) return false // ordinary idle TTL ping
  return false
}

/**
 * Upsert live_sessions from an HTTP request, then publish analytics SSE (after DB write).
 * Ordinary same-state heartbeats are coalesced / pressure-suppressed; meaningful
 * channel/online transitions publish analytics.presence_changed immediately.
 *
 * Under pool pressure, redundant ordinary UPSERTs are skipped when a recent write
 * still keeps the device inside the live TTL window — freeing capacity for verify/payment.
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
  const meaningful = isLikelyMeaningfulPresenceRequest(d, {
    clearChannel,
    channelRef,
    hint,
    event,
  })

  if (shouldSkipOrdinaryPresenceUpsert(d, { meaningful })) {
    return {
      deviceId: d,
      published: false,
      event: String(event || 'analytics.session_heartbeat'),
      presenceChanged: false,
      skippedUpsert: 'pool_pressure_ttl_fresh',
    }
  }

  // Skip expensive geo on routine heartbeats when pool is pressured.
  let country = null
  if (meaningful || canPublishOrdinaryTelemetry()) {
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

  markOrdinaryPresenceWritten(d)
  return publishAfterLivePresenceUpsert(d, touch, { event })
}

export { canUseBackgroundDb }
