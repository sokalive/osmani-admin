/**
 * Verify-path DB resilience: concurrency slots + safe inactive fallback under pool pressure.
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
  const configured = Math.max(4, Math.min(40, Number(process.env.VERIFY_DB_MAX_CONCURRENT) || 25))
  if (isVpsProduction()) return configured
  // Render starter pool (max 8): cap verify slots so LISTEN relay + routes keep headroom.
  const poolMax = getPoolStats().max || poolMaxConnections()
  const ceiling = Math.max(2, poolMax - 2)
  return Math.min(configured, ceiling)
}

function verifyDbSlotWaitMs() {
  return Math.max(200, Math.min(120_000, Number(process.env.VERIFY_DB_SLOT_WAIT_MS) || 30000))
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
  return (
    err instanceof DbPressureError ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('query_timeout') ||
    msg.includes('db_pressure') ||
    msg.includes('verify_db_slot_wait') ||
    msg.includes('connection terminated') ||
    msg.includes('too many clients')
  )
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

/**
 * Safe to return inactive fallback (never downgrade paid users, never skip payment/migration).
 */
export function canUseInactiveVerifyFallback({
  orderIdHint,
  fingerprint,
  legacyDeviceId,
  accountId,
  paymentPhone,
  cachedAccessRow,
} = {}) {
  const hint = String(orderIdHint ?? '').trim()
  if (hint) return false

  const phone = String(paymentPhone ?? '').replace(/\D/g, '')
  if (phone.length >= 10) return false
  if (String(legacyDeviceId ?? '').trim()) return false
  if (String(accountId ?? '').trim()) return false
  if (String(fingerprint ?? '').trim()) return false

  const row = cachedAccessRow
  if (row?.active_now === true && row?.blocked_now !== true && String(row?.status ?? '').toLowerCase() === 'active') {
    return false
  }

  return true
}
