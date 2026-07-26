/**
 * Fire-and-forget warm of the dashboard snapshot before React paints.
 * Writes into adminSnapshotCache so the home dashboard hydrates instantly.
 * Never blocks UI; never mutates subscription/payment entitlements.
 */
import { getAnalyticsSnapshot, getAnalyticsTrend } from './api'
import { writeAdminSnapshot } from './adminSnapshotCache'
import {
  fetchDeviceIntelligenceSummary,
  writeDeviceIntelligenceSummaryCache,
} from './deviceIntelligenceSummary'

let started = false
let dashboardPromise = null

async function warmDashboard() {
  const [snap, trend, deviceSummary] = await Promise.all([
    getAnalyticsSnapshot().catch(() => null),
    getAnalyticsTrend().catch(() => null),
    fetchDeviceIntelligenceSummary().catch(() => null),
  ])
  if (!snap || typeof snap !== 'object') return null

  const registryTotal = Number(deviceSummary?.totalDevicesEverSeen)
  const overview = {
    onlineNow: snap.onlineNow,
    watchingNow: snap.watchingNow,
    idleNow: snap.idleNow,
    totalUniqueDevices:
      Number.isFinite(registryTotal) && registryTotal >= 0
        ? registryTotal
        : Number(snap.totalUniqueDevices) || 0,
    revenueToday: snap.revenueToday,
    newUsersToday: snap.newUsersToday,
    dauToday: snap.dauToday,
    livePresenceWindowSeconds: snap.livePresenceWindowSeconds,
  }
  const channels = Array.isArray(snap.mostWatched) ? snap.mostWatched : []
  const topFiveChannels = Array.isArray(snap.top5) ? snap.top5 : []
  const channelLabels =
    snap.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {}
  const locations = Array.isArray(snap.locations) ? snap.locations : []
  const nextTrend = Array.isArray(trend)
    ? trend.map((x) => ({
        time: new Date(x.time).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Africa/Dar_es_Salaam',
        }),
        users: Number(x.users) || 0,
      }))
    : []

  if (deviceSummary) writeDeviceIntelligenceSummaryCache(deviceSummary)
  writeAdminSnapshot('dashboard', {
    overview,
    channels,
    topFiveChannels,
    channelLabels,
    locations,
    trend: nextTrend,
  })
  return { overview, channels, topFiveChannels, channelLabels, locations, trend: nextTrend }
}

/** Start background warm. Safe to call multiple times. */
export function startAdminBootPreload() {
  if (started || typeof window === 'undefined') return dashboardPromise
  started = true
  dashboardPromise = warmDashboard().catch(() => null)
  return dashboardPromise
}

export function getDashboardPreloadPromise() {
  return dashboardPromise
}
