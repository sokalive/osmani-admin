/**
 * Live presence TTL for dashboard widgets (channels, locations, online now).
 * Separate from row prune so stale devices drop off quickly without tight DELETE on every read.
 */
import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'

function clampInt(n, min, max) {
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Rows count as "live" when updated_at is within this window (default 18s, clamp 10–45). */
export const LIVE_PRESENCE_WINDOW_SECONDS = (() => {
  const explicit = clampInt(Number(process.env.ANALYTICS_LIVE_PRESENCE_WINDOW_SECONDS), 10, 45)
  if (explicit != null) return explicit
  const legacy = clampInt(Number(process.env.ANALYTICS_SESSION_TTL_SECONDS), 10, 45)
  if (legacy != null) return legacy
  return 18
})()

/** DELETE idle rows after this (default max(window+30, 90), min window+5). */
export const SESSION_PRUNE_SECONDS = (() => {
  const explicit = clampInt(Number(process.env.ANALYTICS_SESSION_PRUNE_SECONDS), 15, 600)
  if (explicit != null) {
    return Math.max(explicit, LIVE_PRESENCE_WINDOW_SECONDS + 5)
  }
  return Math.max(LIVE_PRESENCE_WINDOW_SECONDS + 30, 90)
})()

export const JANITOR_INTERVAL_MS = Math.min(
  30_000,
  Math.max(8_000, Number(process.env.ANALYTICS_PRESENCE_JANITOR_MS) || 10_000),
)

export function livePresenceWindowInterval() {
  return `${LIVE_PRESENCE_WINDOW_SECONDS} seconds`
}

export function livePresencePruneInterval() {
  return `${SESSION_PRUNE_SECONDS} seconds`
}

/**
 * Remove idle live_sessions rows and notify analytics SSE subscribers.
 * @returns {Promise<string[]>} device_ids removed
 */
export async function cleanupStaleSessions(pool) {
  if (!pool) return []
  try {
    const { rows } = await pool.query(
      `DELETE FROM live_sessions
       WHERE COALESCE(updated_at, started_at, now()) < (now() - $1::interval)
       RETURNING device_id`,
      [livePresencePruneInterval()],
    )
    const deviceIds = rows.map((r) => String(r.device_id ?? '').trim()).filter(Boolean)
    if (deviceIds.length === 0) return deviceIds

    for (const deviceId of deviceIds) {
      liveSyncBus.publish('analytics.session_end', { topics: ['analytics'], deviceId })
    }
    liveSyncBus.publish('analytics.presence_expired', {
      topics: ['analytics'],
      deviceIds,
      count: deviceIds.length,
    })
    return deviceIds
  } catch (e) {
    console.error('[livePresence] cleanupStaleSessions:', e)
    return []
  }
}

let janitorTimer = null

/** Background prune so disconnects clear even between dashboard polls. */
export function startLivePresenceJanitor() {
  if (janitorTimer) return
  janitorTimer = setInterval(() => {
    const pool = getPool()
    if (!pool) return
    void cleanupStaleSessions(pool)
  }, JANITOR_INTERVAL_MS)
  if (typeof janitorTimer.unref === 'function') janitorTimer.unref()
}
