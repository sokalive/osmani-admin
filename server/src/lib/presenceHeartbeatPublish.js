/**
 * Coalesce analytics.session_heartbeat bus publishes (Admin SSE / relay).
 * Presence DB UPSERTs stay on their own cadence — this only limits fan-out.
 */

const HEARTBEAT_PUBLISH_MIN_MS = Math.max(
  2_000,
  Math.min(30_000, Number(process.env.PRESENCE_HEARTBEAT_PUBLISH_MS) || 10_000),
)

/** @type {Map<string, number>} */
const lastHeartbeatPublishAt = new Map()

function pruneHeartbeatPublishMap(now) {
  if (lastHeartbeatPublishAt.size < 4_000) return
  const cutoff = now - HEARTBEAT_PUBLISH_MIN_MS * 6
  for (const [id, at] of lastHeartbeatPublishAt) {
    if (at < cutoff) lastHeartbeatPublishAt.delete(id)
  }
  if (lastHeartbeatPublishAt.size > 8_000) {
    lastHeartbeatPublishAt.clear()
  }
}

/**
 * @param {string} deviceId
 * @returns {boolean} true when a bus publish should proceed
 */
export function shouldPublishSessionHeartbeat(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const now = Date.now()
  pruneHeartbeatPublishMap(now)
  const last = lastHeartbeatPublishAt.get(d) || 0
  if (now - last < HEARTBEAT_PUBLISH_MIN_MS) return false
  lastHeartbeatPublishAt.set(d, now)
  return true
}

export function getHeartbeatPublishMinMs() {
  return HEARTBEAT_PUBLISH_MIN_MS
}
