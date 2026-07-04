/**
 * Pool query helpers with timeout + slow-query logging.
 * Uses an explicit checkout so statement_timeout applies and the client is always released.
 */
import { getPool, getPoolStats } from '../db/pool.js'

const DEFAULT_QUERY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.PG_QUERY_TIMEOUT_MS) || 8000,
)
const SLOW_QUERY_MS = Math.max(200, Number(process.env.PG_SLOW_QUERY_MS) || 500)

function poolStatsSnapshot() {
  try {
    return getPoolStats()
  } catch {
    return null
  }
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 */
export async function poolQuery(text, params = [], opts = {}) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS)
  const label = String(opts.label || '').trim() || 'query'
  const t0 = performance.now()

  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout TO ${Math.trunc(timeoutMs)}`)
    const result = await client.query(text, params)
    const ms = performance.now() - t0
    if (ms >= SLOW_QUERY_MS) {
      console.warn('[db-slow]', {
        label,
        ms: Math.round(ms),
        pool: poolStatsSnapshot(),
      })
    }
    return result
  } catch (e) {
    const ms = performance.now() - t0
    console.warn('[db-query-error]', {
      label,
      ms: Math.round(ms),
      error: String(e?.message || e),
      pool: poolStatsSnapshot(),
    })
    throw e
  } finally {
    await client.query('RESET statement_timeout').catch(() => {})
    client.release()
  }
}
