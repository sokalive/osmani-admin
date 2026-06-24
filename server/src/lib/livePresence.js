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

/** Rows count as "live" when updated_at is within this window (default 45s, clamp 10–120). */
export const LIVE_PRESENCE_WINDOW_SECONDS = (() => {
  const explicit = clampInt(Number(process.env.ANALYTICS_LIVE_PRESENCE_WINDOW_SECONDS), 10, 120)
  if (explicit != null) return explicit
  const legacy = clampInt(Number(process.env.ANALYTICS_SESSION_TTL_SECONDS), 10, 120)
  if (legacy != null) return legacy
  return 60
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

/** SQL predicate: row counts as live for dashboard presence widgets. */
export function liveSessionActiveWhere(alias = '') {
  const p = alias ? `${alias}.` : ''
  return `COALESCE(${p}updated_at, ${p}started_at, now()) >= (now() - $1::interval)`
}

export function livePresencePruneInterval() {
  return `${SESSION_PRUNE_SECONDS} seconds`
}

const ADVISORY_LOCK_KEY = 871234001

/**
 * Remove idle live_sessions rows and notify analytics SSE subscribers.
 * Uses pg advisory lock so only one worker prunes at a time (Render + VPS PM2).
 * @returns {Promise<string[]>} device_ids removed
 */
export async function cleanupStaleSessions(pool) {
  if (!pool) return []
  let locked = false
  try {
    const lockRes = await pool.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY])
    locked = lockRes.rows[0]?.ok === true
    if (!locked) return []

    const { rows } = await pool.query(
      `DELETE FROM live_sessions
       WHERE COALESCE(updated_at, started_at, now()) < (now() - $1::interval)
       RETURNING device_id`,
      [livePresencePruneInterval()],
    )
    const deviceIds = rows.map((r) => String(r.device_id ?? '').trim()).filter(Boolean)
    if (deviceIds.length === 0) return deviceIds

    liveSyncBus.publish('analytics.presence_expired', {
      topics: ['analytics'],
      deviceIds,
      count: deviceIds.length,
    })
    return deviceIds
  } catch (e) {
    console.error('[livePresence] cleanupStaleSessions:', e)
    return []
  } finally {
    if (locked) {
      await pool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {})
    }
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
