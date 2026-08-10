/**
 * Decide bus event after a live_sessions UPSERT:
 * - meaningful state change → analytics.presence_changed (immediate)
 * - ordinary same-state TTL refresh → coalesced analytics.session_heartbeat
 * - explicit start/end-style events → publish as requested
 */
import { liveSyncBus } from './liveSyncBus.js'
import {
  shouldPublishSessionHeartbeat,
  markSessionHeartbeatPublished,
} from './presenceHeartbeatPublish.js'

/**
 * @param {string} deviceId
 * @param {{
 *   presenceChanged?: boolean,
 *   channelId?: string | null,
 *   previousChannelId?: string | null,
 *   created?: boolean,
 *   channelChanged?: boolean,
 * } | null | undefined} touch
 * @param {{ event?: string }} [opts]
 * @returns {{ deviceId: string, published: boolean, event: string, presenceChanged: boolean }}
 */
export function publishAfterLivePresenceUpsert(
  deviceId,
  touch,
  { event = 'analytics.session_heartbeat' } = {},
) {
  const d = String(deviceId ?? '').trim()
  if (!d) {
    return { deviceId: '', published: false, event: String(event || ''), presenceChanged: false }
  }

  const eventName = String(event || 'analytics.session_heartbeat')
  const presenceChanged = touch?.presenceChanged === true
  const channelId = touch?.channelId ?? null
  const previousChannelId = touch?.previousChannelId ?? null

  if (eventName !== 'analytics.session_heartbeat') {
    markSessionHeartbeatPublished(d)
    liveSyncBus.publish(eventName, {
      topics: ['analytics'],
      deviceId: d,
      presenceChanged,
      channelId,
      previousChannelId,
    })
    return { deviceId: d, published: true, event: eventName, presenceChanged }
  }

  if (presenceChanged) {
    markSessionHeartbeatPublished(d)
    liveSyncBus.publish('analytics.presence_changed', {
      topics: ['analytics'],
      deviceId: d,
      channelId,
      previousChannelId,
      created: touch?.created === true,
      channelChanged: touch?.channelChanged === true,
    })
    return {
      deviceId: d,
      published: true,
      event: 'analytics.presence_changed',
      presenceChanged: true,
    }
  }

  if (!shouldPublishSessionHeartbeat(d)) {
    return { deviceId: d, published: false, event: eventName, presenceChanged: false }
  }

  liveSyncBus.publish(eventName, { topics: ['analytics'], deviceId: d })
  return { deviceId: d, published: true, event: eventName, presenceChanged: false }
}
