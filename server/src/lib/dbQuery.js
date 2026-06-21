/**
 * Pool query helpers with timeout + slow-query logging.
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

  let timer
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`query_timeout:${label}:${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([pool.query(text, params), timeoutPromise])
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
    clearTimeout(timer)
  }
}
