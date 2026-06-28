/**
 * Canonical live presence metrics — single source for dashboard widgets.
 * All counts read from `live_sessions` with the same TTL window.
 */
import { LIVE_PRESENCE_WINDOW_SECONDS, livePresenceWindowInterval, liveSessionActiveWhere } from './livePresence.js'

const LIVE_WINDOW_INTERVAL = livePresenceWindowInterval()

function numOrZero(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Active session totals (online = watching + idle). */
export async function queryLivePresenceTotals(pool) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS online_now,
       COUNT(*) FILTER (
         WHERE channel_id IS NOT NULL AND trim(channel_id) <> ''
       )::int AS watching_now,
       COUNT(*) FILTER (
         WHERE channel_id IS NULL OR trim(channel_id) = ''
       )::int AS idle_now
     FROM live_sessions
     WHERE ${liveSessionActiveWhere()}`,
    [LIVE_WINDOW_INTERVAL],
  )
  const row = rows[0] || {}
  const onlineNow = numOrZero(row.online_now)
  const watchingNow = numOrZero(row.watching_now)
  const idleNow = numOrZero(row.idle_now)
  return {
    onlineNow,
    watchingNow,
    idleNow,
    livePresenceWindowSeconds: LIVE_PRESENCE_WINDOW_SECONDS,
  }
}

/** Channel viewer rows (devices with an active channel). */
export async function queryLiveChannelStats(pool) {
  const { rows } = await pool.query(
    `WITH active AS (
       SELECT ls.device_id, trim(ls.channel_id) AS raw_channel_id
       FROM live_sessions ls
       WHERE ls.channel_id IS NOT NULL
         AND trim(ls.channel_id) <> ''
         AND ${liveSessionActiveWhere('ls')}
     ),
     normalized AS (
       SELECT a.device_id,
         COALESCE(c.id::text, a.raw_channel_id) AS channel_id
       FROM active a
       LEFT JOIN channels c ON (
         c.id::text = a.raw_channel_id
         OR lower(trim(c.name)) = lower(a.raw_channel_id)
       )
     )
     SELECT channel_id, COUNT(*)::int AS viewers
     FROM normalized
     GROUP BY channel_id
     ORDER BY viewers DESC`,
    [LIVE_WINDOW_INTERVAL],
  )
  return rows.map((r) => ({
    channel_id: String(r.channel_id),
    viewers: numOrZero(r.viewers),
  }))
}

/** Location buckets for all active sessions (watching + idle). */
export async function queryLiveLocationBuckets(pool) {
  const { rows } = await pool.query(
    `SELECT
       CASE
         WHEN country IS NOT NULL AND trim(country) <> '' THEN country
         ELSE 'Unknown'
       END AS country,
       COUNT(*)::int AS users
     FROM live_sessions
     WHERE ${liveSessionActiveWhere()}
     GROUP BY 1
     ORDER BY users DESC`,
    [LIVE_WINDOW_INTERVAL],
  )
  return rows
}

/** Sum viewers across channel rows — must match watchingNow when data is consistent. */
export function sumChannelViewers(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.reduce((sum, row) => sum + numOrZero(row?.viewers), 0)
}
