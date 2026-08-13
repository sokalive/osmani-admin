/**
 * Cap concurrent presence UPSERT/DB work so kickoff bursts cannot exhaust
 * the shared pool that verify/payment/channel-auth need.
 */
import { getPoolStats } from '../db/pool.js'
import { criticalPoolHeadroom } from './telemetryAdmission.js'

let presenceInFlight = 0

export function maxPresenceDbConcurrent() {
  const max = Number(getPoolStats()?.max) || 50
  const headroom = criticalPoolHeadroom(max)
  // Leave critical headroom free for verify/payment even during open storms.
  return Math.max(8, max - headroom)
}

export function getPresenceAdmissionStats() {
  return {
    inFlight: presenceInFlight,
    maxConcurrent: maxPresenceDbConcurrent(),
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ meaningful?: boolean }} [opts]
 * @returns {Promise<T | { skipped: string }>}
 */
export async function withPresenceDbSlot(fn, { meaningful = false } = {}) {
  const max = maxPresenceDbConcurrent()
  const waitBudgetMs = meaningful
    ? Math.max(200, Math.min(4000, Number(process.env.PRESENCE_ADMISSION_WAIT_MS) || 2000))
    : 0
  const t0 = Date.now()
  while (presenceInFlight >= max) {
    if (!meaningful) {
      return { skipped: 'presence_admission' }
    }
    if (Date.now() - t0 >= waitBudgetMs) {
      const err = new Error('presence_admission_timeout')
      err.code = 'PRESENCE_ADMISSION_TIMEOUT'
      err.statusCode = 503
      err.retryable = true
      throw err
    }
    await new Promise((r) => setTimeout(r, 15))
  }
  presenceInFlight += 1
  try {
    return await fn()
  } finally {
    presenceInFlight -= 1
  }
}
