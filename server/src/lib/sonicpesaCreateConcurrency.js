/**
 * Cross-process cap on outbound SonicPesa create-order calls.
 * Postgres advisory locks are held on one pooled connection per in-flight call.
 * PM2 is fork/instances=1 today; the locks still coordinate if that changes.
 */
import { getPool } from '../db/pool.js'
import { sonicpesaCheckoutLimits } from './sonicpesaCheckoutPolicy.js'
import { noteCheckoutMetric } from './sonicpesaCheckoutMetrics.js'

const SLOT_BASE = 881000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: 'capacity' }>}
 */
export async function withSonicpesaCreateSlot(fn) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  const limits = sonicpesaCheckoutLimits()
  const client = await pool.connect()
  let slot = null
  const waitDeadline = Date.now() + limits.queueWaitMs
  try {
    while (slot == null) {
      for (let i = 1; i <= limits.maxConcurrent; i += 1) {
        const key = SLOT_BASE + i
        const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [key])
        if (r.rows[0]?.ok === true) {
          slot = key
          break
        }
      }
      if (slot != null) break
      if (Date.now() >= waitDeadline) {
        noteCheckoutMetric('capacity_exhausted')
        return { ok: false, reason: 'capacity' }
      }
      await sleep(80 + Math.floor(Math.random() * 120))
    }
    noteCheckoutMetric('slot_acquired')
    const value = await fn()
    return { ok: true, value }
  } finally {
    let unlockError = null
    if (slot != null) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [slot])
      } catch (e) {
        unlockError = e
      }
    }
    client.release(unlockError || undefined)
  }
}
