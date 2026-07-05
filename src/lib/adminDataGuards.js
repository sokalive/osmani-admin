/** Guards against destructive overwrites of last-known-good Admin UI state. */

export function isDegradedAnalyticsSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return true
  if (snap.degraded === true || snap.error) return true
  return false
}

/** True when snapshot has no meaningful overview fields (transient empty/error payload). */
export function isEmptyAnalyticsOverview(snap) {
  if (!snap || typeof snap !== 'object') return true
  const hasDevices = Number(snap.totalUniqueDevices) > 0
  const hasPresence = Number(snap.onlineNow) > 0
  const hasChannels = Array.isArray(snap.mostWatched) && snap.mostWatched.length > 0
  const hasLocations = Array.isArray(snap.locations) && snap.locations.length > 0
  return !hasDevices && !hasPresence && !hasChannels && !hasLocations
}

/**
 * Apply fresh analytics snapshot only when it improves on cached state.
 * @param {object|null} prev prior overview slice
 * @param {object|null} next incoming overview slice
 * @param {object} fullSnap full API response for degradation checks
 */
export function mergeAnalyticsOverview(prev, next, fullSnap) {
  if (isDegradedAnalyticsSnapshot(fullSnap)) return prev ?? next
  if (!next || typeof next !== 'object') return prev ?? next
  if (prev && isEmptyAnalyticsOverview(fullSnap) && Number(prev.totalUniqueDevices) > 0) {
    return prev
  }
  return { ...(prev && typeof prev === 'object' ? prev : {}), ...next }
}

export function shouldReplaceRows(prevRows, nextRows, { allowEmpty = false } = {}) {
  if (!Array.isArray(nextRows)) return false
  if (nextRows.length === 0 && Array.isArray(prevRows) && prevRows.length > 0 && !allowEmpty) {
    return false
  }
  return true
}
