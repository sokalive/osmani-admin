/**
 * Non-critical / background DB admission.
 *
 * CRITICAL work (verify, payment activation, channel auth, meaningful presence
 * transitions) always competes for the pool.
 *
 * BACKGROUND work (ordinary TTL presence UPSERT, geo, Admin heartbeat fan-out)
 * must leave headroom so critical paths are not starved under match load.
 */
import { getPoolStats } from '../db/pool.js'

/** @type {Map<string, number>} */
const lastOrdinaryPresenceWriteAt = new Map()

const ORDINARY_PRESENCE_MIN_MS = Math.max(
  5_000,
  Math.min(25_000, Number(process.env.PRESENCE_ORDINARY_UPSERT_MIN_MS) || 12_000),
)

function pruneTouchMap(now) {
  if (lastOrdinaryPresenceWriteAt.size < 4_000) return
  const cutoff = now - ORDINARY_PRESENCE_MIN_MS * 4
  for (const [id, at] of lastOrdinaryPresenceWriteAt) {
    if (at < cutoff) lastOrdinaryPresenceWriteAt.delete(id)
  }
  if (lastOrdinaryPresenceWriteAt.size > 8_000) lastOrdinaryPresenceWriteAt.clear()
}

/** Slots reserved for verify/payment/meaningful presence under pressure. */
export function criticalPoolHeadroom(poolMax = Number(getPoolStats()?.max) || 40) {
  const configured = Number(process.env.PG_POOL_CRITICAL_HEADROOM)
  if (Number.isFinite(configured) && configured >= 2) {
    return Math.min(Math.floor(poolMax / 2), Math.trunc(configured))
  }
  // ~25% of pool, clamp 8–16
  return Math.max(8, Math.min(16, Math.floor(poolMax * 0.25)))
}

/**
 * @returns {boolean} true when ordinary heartbeat fan-out / geo may proceed
 */
export function canPublishOrdinaryTelemetry() {
  return canUseBackgroundDb()
}

/**
 * Background DB work allowed only when the pool has spare capacity above
 * the critical headroom reservation.
 */
export function canUseBackgroundDb() {
  try {
    const s = getPoolStats()
    if (!s || !s.max) return true
    if (s.saturated === true || s.startupLocked === true) return false
    if ((Number(s.waitingCount) || 0) > 0) return false
    const idle = Number(s.idleCount) || 0
    const headroom = criticalPoolHeadroom(Number(s.max) || 40)
    if (idle <= headroom) return false
    return true
  } catch {
    return true
  }
}

/**
 * Under pool pressure, skip redundant same-state presence UPSERTs when the
 * device was written recently enough to stay inside the live presence TTL window.
 * Meaningful transitions must never skip.
 *
 * @param {string} deviceId
 * @param {{ meaningful?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldSkipOrdinaryPresenceUpsert(deviceId, { meaningful = false } = {}) {
  if (meaningful) return false
  const d = String(deviceId ?? '').trim()
  if (!d) return true
  if (canUseBackgroundDb()) return false
  const now = Date.now()
  pruneTouchMap(now)
  const last = lastOrdinaryPresenceWriteAt.get(d) || 0
  return now - last < ORDINARY_PRESENCE_MIN_MS
}

export function markOrdinaryPresenceWritten(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  const now = Date.now()
  pruneTouchMap(now)
  lastOrdinaryPresenceWriteAt.set(d, now)
}

export function getOrdinaryPresenceMinMs() {
  return ORDINARY_PRESENCE_MIN_MS
}
