/**
 * Non-critical telemetry admission: under pool pressure, skip bus fan-out /
 * Admin-driving publishes so verify/payment/presence UPSERTs keep capacity.
 * Never blocks DB presence writes or payment/subscription business paths.
 */
import { getPoolStats } from '../db/pool.js'

/**
 * @returns {boolean} true when ordinary heartbeat fan-out should proceed
 */
export function canPublishOrdinaryTelemetry() {
  try {
    const s = getPoolStats()
    if (!s || !s.max) return true
    if (s.saturated === true || s.startupLocked === true) return false
    if ((Number(s.waitingCount) || 0) > 0) return false
    // Keep headroom for verify (12) + payment/webhooks when nearly fully checked out.
    if ((Number(s.idleCount) || 0) === 0 && (Number(s.totalCount) || 0) >= (Number(s.max) || 30) - 2) {
      return false
    }
    return true
  } catch {
    return true
  }
}
