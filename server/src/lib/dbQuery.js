/**
 * Pool query helpers with timeout + slow-query logging + saturation fail-fast.
 * Uses an explicit checkout so statement_timeout applies and the client is always released.
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
  // pool.connect is patched with acquire timeout + saturation fail-fast.
  const client = await pool.connect()
  let destroyOnRelease = false
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
    // Never let RESET hang forever with the client still checked out — that
    // starved Contabo (idleCount=0 / PG idle+ClientRead) during startup.
    try {
      await Promise.race([
        client.query('RESET statement_timeout'),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('reset_statement_timeout_hung')), 750)
        }),
      ])
    } catch {
      destroyOnRelease = true
    }
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
