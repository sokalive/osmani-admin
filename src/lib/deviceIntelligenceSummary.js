/**
 * Shared unique-device total from Users Intelligence registry.
 * Single source of truth for Dashboard, Users Intelligence, and Device Registry.
 */
import { getUsersIntelligenceSummary } from './api'
import { readAdminSnapshot, writeAdminSnapshot } from './adminSnapshotCache'

export const DEVICE_INTELLIGENCE_SUMMARY_CACHE_KEY = 'device-intelligence-summary'
export const USERS_INTELLIGENCE_CACHE_KEY = 'users-intelligence'

/** @returns {number|null} cached totalDevicesEverSeen, or null if unknown */
export function readCachedUniqueDevicesTotal() {
  const summarySnap = readAdminSnapshot(DEVICE_INTELLIGENCE_SUMMARY_CACHE_KEY)
  const fromSummary = Number(summarySnap?.totalDevicesEverSeen)
  if (Number.isFinite(fromSummary) && fromSummary >= 0) return fromSummary

  const ui = readAdminSnapshot(USERS_INTELLIGENCE_CACHE_KEY)
  const fromUi = Number(ui?.summary?.totalDevicesEverSeen)
  if (Number.isFinite(fromUi) && fromUi >= 0) return fromUi

  return null
}

/** Persist summary so Dashboard / registry pages stay aligned without duplicate list fetches. */
export function writeDeviceIntelligenceSummaryCache(summary) {
  if (!summary || typeof summary !== 'object') return
  writeAdminSnapshot(DEVICE_INTELLIGENCE_SUMMARY_CACHE_KEY, summary)
  const ui = readAdminSnapshot(USERS_INTELLIGENCE_CACHE_KEY)
  if (ui && typeof ui === 'object') {
    writeAdminSnapshot(USERS_INTELLIGENCE_CACHE_KEY, { ...ui, summary })
  }
}

/**
 * Lightweight summary fetch (no list query).
 * @returns {Promise<{ totalDevicesEverSeen: number, activeDevices: number, blockedDevices: number, inactiveDevices: number }|null>}
 */
export async function fetchDeviceIntelligenceSummary() {
  const data = await getUsersIntelligenceSummary()
  const summary = data?.summary ?? data
  if (!summary || typeof summary !== 'object') return null
  writeDeviceIntelligenceSummaryCache(summary)
  return summary
}
