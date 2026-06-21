/**
 * Read-only PostgreSQL connection stats for health / benchmarks.
 */
import { poolQuery } from './dbQuery.js'
import { getPool, getPoolStats } from '../db/pool.js'

export async function findSampleActiveDeviceId() {
  const ids = await findSampleActiveDeviceIds(1)
  return ids[0] ?? null
}

export async function findSampleActiveDeviceIds(limit = 10) {
  const pool = getPool()
  if (!pool) return []
  const n = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 10)))
  const { rows } = await poolQuery(
    `SELECT device_id
     FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()
     ORDER BY expires_at DESC
     LIMIT $1`,
    [n],
    { label: 'sample_active_devices', timeoutMs: 5000 },
  )
  return rows.map((r) => String(r.device_id ?? '')).filter(Boolean)
}

export async function readPgConnectionStats() {
  const pool = getPool()
  if (!pool) {
    return { ok: false, reason: 'no_pool', pool: getPoolStats() }
  }
  try {
    const [maxRes, countRes, stateRes] = await Promise.all([
      poolQuery(`SHOW max_connections`, [], { label: 'pg_max_connections', timeoutMs: 3000 }),
      poolQuery(`SELECT count(*)::int AS total FROM pg_stat_activity`, [], {
        label: 'pg_activity_count',
        timeoutMs: 3000,
      }),
      poolQuery(
        `SELECT state, count(*)::int AS n
         FROM pg_stat_activity
         GROUP BY state
         ORDER BY n DESC`,
        [],
        { label: 'pg_activity_by_state', timeoutMs: 3000 },
      ),
    ])
    const max_connections = Number(maxRes.rows?.[0]?.max_connections) || null
    const active_connections = Number(countRes.rows?.[0]?.total) || 0
    const by_state = Object.fromEntries(
      (stateRes.rows || []).map((r) => [String(r.state ?? 'null'), Number(r.n) || 0]),
    )
    return {
      ok: true,
      max_connections,
      active_connections,
      by_state,
      pool: getPoolStats(),
    }
  } catch (e) {
    return {
      ok: false,
      reason: String(e?.message || e),
      pool: getPoolStats(),
    }
  }
}
