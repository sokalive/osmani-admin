/**
 * Pool query helpers with timeout + slow-query logging + saturation fail-fast.
 * Uses an explicit checkout so the client is always released promptly.
 *
 * IMPORTANT: do NOT RUN `RESET statement_timeout` in finally. Contabo saturation
 * showed all 30 clients stuck checked-out with last query RESET / PG idle+ClientRead
 * while waitingCount climbed — release must be immediate after the user query.
 */
import { getPool, getPoolStats } from '../db/pool.js'
import { isPoolSaturationError, assertPoolCanAcceptWork } from './poolSaturation.js'

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

  assertPoolCanAcceptWork(getPoolStats, label)
  const client = await pool.connect()
  let destroyOnRelease = false
  let timer = null
  try {
    // Session SET is fine; next checkout overwrites. Never RESET before release.
    await client.query(`SET statement_timeout TO ${Math.trunc(timeoutMs)}`)
    const result = await Promise.race([
      client.query(text, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          destroyOnRelease = true
          reject(new Error(`query_timeout:${label}:${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
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
    if (!isPoolSaturationError(e)) {
      console.warn('[db-query-error]', {
        label,
        ms: Math.round(ms),
        error: String(e?.message || e),
        pool: poolStatsSnapshot(),
      })
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    try {
      client.release(destroyOnRelease)
    } catch {
      try {
        client.release(true)
      } catch {
        /* ignore */
      }
    }
  }
}

export { isPoolSaturationError }
