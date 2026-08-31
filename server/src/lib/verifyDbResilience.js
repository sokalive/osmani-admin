/**
 * Verify-path DB resilience: concurrency slots + retryable failure under pool pressure.
 * Temporary verification failure must never be represented as confirmed inactive (active:false).
 */
import { getPoolStats, isVpsProduction, poolMaxConnections } from '../db/pool.js'

export class DbPressureError extends Error {
  constructor(message = 'db_pressure') {
    super(message)
    this.name = 'DbPressureError'
    this.code = 'DB_PRESSURE'
  }
}

function maxVerifyDbConcurrent() {
  const poolMax = getPoolStats().max || poolMaxConnections()
  // Leave headroom for checkout-providers, plans, webhooks, admin, presence.
  const headroom = isVpsProduction() ? 14 : 2
  const ceiling = Math.max(2, poolMax - headroom)
  const configuredDefault = isVpsProduction() ? 16 : 6
  const envCap = Number(process.env.VERIFY_DB_MAX_CONCURRENT)
  const configured = Number.isFinite(envCap) && envCap >= 1 ? Math.trunc(envCap) : configuredDefault
  return Math.max(2, Math.min(ceiling, configured))
}

function verifyDbSlotWaitMs() {
  // Fail faster under pressure so verify does not hold thousands of waiters.
  return Math.max(200, Math.min(15_000, Number(process.env.VERIFY_DB_SLOT_WAIT_MS) || 4000))
}

let verifyDbInFlight = 0

export function getVerifyDbStats() {
  return {
    inFlight: verifyDbInFlight,
    maxConcurrent: maxVerifyDbConcurrent(),
    pool: getPoolStats(),
  }
}

export function isVerifyDbPressure() {
  const pool = getPoolStats()
  const max = maxVerifyDbConcurrent()
  return verifyDbInFlight >= max || pool.waitingCount > 0 || pool.totalCount >= pool.max
}

export function isDbTimeoutOrPressureError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  const code = String(err?.code ?? '').toLowerCase()
  return (
    err instanceof DbPressureError ||
    err?.code === 'POOL_SATURATED' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === '57p01' ||
    code === '53300' ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('query_timeout') ||
    msg.includes('db_pressure') ||
    msg.includes('verify_db_slot_wait') ||
    msg.includes('pool_saturated') ||
    msg.includes('pool_acquire_timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('connection reset') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('too many clients') ||
    msg.includes('remaining connection slots')
  )
}

/** Machine-readable reason for retryable verify unavailability (never active:false). */
export function subscriptionVerifyUnavailableReason(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  if (err?.code === 'POOL_SATURATED' || msg.includes('pool_saturated')) return 'pool_saturated'
  if (msg.includes('pool_acquire_timeout')) return 'pool_acquire_timeout'
  if (msg.includes('verify_db_slot_wait')) return 'verify_db_slot_wait_exceeded'
  if (msg.includes('query_timeout')) return 'query_timeout'
  if (msg.includes('too many clients') || msg.includes('remaining connection slots')) {
    return 'too_many_clients'
  }
  if (msg.includes('connection reset') || msg.includes('econnreset') || msg.includes('connection terminated')) {
    return 'connection_error'
  }
  if (msg.includes('timeout exceeded when trying to connect')) return 'connection_timeout'
  return 'subscription_verification_unavailable'
}

/**
 * Retryable verify payload when DB/pool evidence is unavailable.
 * active is null — never false without authoritative DB confirmation.
 */
export function buildSubscriptionVerifyUnavailableBody(err) {
  const reason = subscriptionVerifyUnavailableReason(err)
  return {
    ok: false,
    active: null,
    retryable: true,
    reason,
    error: reason,
    verification_unavailable: true,
  }
}

/**
 * Resolve HTTP outcome after last-resort active fallback attempt.
 * @param {unknown} err
 * @param {object|null|undefined} lastResortActiveBody
 */
export function resolveVerifyErrorHttpOutcome(err, lastResortActiveBody = null) {
  if (lastResortActiveBody) {
    return { status: 200, body: lastResortActiveBody, retryable: false, retryAfterSec: null }
  }
  if (isDbTimeoutOrPressureError(err)) {
    return {
      status: 503,
      body: buildSubscriptionVerifyUnavailableBody(err),
      retryable: true,
      retryAfterSec: 2,
    }
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: String(err?.message || err || 'verify_error'),
      retryable: false,
    },
    retryable: false,
    retryAfterSec: null,
  }
}

/** Fallback only for slot-queue pressure — not arbitrary query timeouts (may hide paid state). */
export function isVerifySlotPressureError(err) {
  if (err instanceof DbPressureError) return true
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('verify_db_slot_wait')
}

/**
 * Limit concurrent verify DB work; fail fast with DbPressureError when wait exceeds budget.
 */
export async function withVerifyDbSlot(fn) {
  const max = maxVerifyDbConcurrent()
  const waitMs = verifyDbSlotWaitMs()
  const t0 = Date.now()
  while (verifyDbInFlight >= max) {
    if (Date.now() - t0 >= waitMs) {
      throw new DbPressureError('verify_db_slot_wait_exceeded')
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  verifyDbInFlight += 1
  try {
    return await fn()
  } finally {
    verifyDbInFlight -= 1
  }
}

