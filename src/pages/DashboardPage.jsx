import { useCallback, useMemo, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import LiveUserLocationsCard from '../components/LiveUserLocationsCard'
import LiveUsersTrendSection from '../components/LiveUsersTrendSection'
import MostWatchedChannelsCard from '../components/MostWatchedChannelsCard'
import MostWatchedChannelsListCard from '../components/MostWatchedChannelsListCard'
import StatCard from '../components/StatCard'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { useAnalyticsLiveRefresh } from '../hooks/useAnalyticsLiveRefresh.js'
import { getAnalyticsSnapshot, getAnalyticsTrend } from '../lib/api'
import { isDegradedAnalyticsSnapshot } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'
import {
  fetchDeviceIntelligenceSummary,
  readCachedUniqueDevicesTotal,
} from '../lib/deviceIntelligenceSummary'

const emerald =
  'bg-gradient-to-br from-emerald-400/92 via-emerald-500/88 to-emerald-700/90'

const OVERVIEW_FALLBACK = {
  onlineNow: 0,
  totalUniqueDevices: 0,
  revenueToday: 0,
  newUsersToday: 0,
}

function hydrateDashboard() {
  const snap = readAdminSnapshot('dashboard')
  const cachedUnique = readCachedUniqueDevicesTotal()
  if (!snap || typeof snap !== 'object') {
    return {
      overview: {
        ...OVERVIEW_FALLBACK,
        ...(cachedUnique != null ? { totalUniqueDevices: cachedUnique } : {}),
      },
      channels: [],
      topFiveChannels: [],
      channelLabels: {},
      locations: [],
      trend: [],
      fromCache: cachedUnique != null,
    }
  }
  const overview = { ...OVERVIEW_FALLBACK, ...(snap.overview || {}) }
  if (cachedUnique != null) overview.totalUniqueDevices = cachedUnique
  return {
    overview,
    channels: Array.isArray(snap.channels) ? snap.channels : [],
    topFiveChannels: Array.isArray(snap.topFiveChannels) ? snap.topFiveChannels : [],
    channelLabels: snap.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {},
    locations: Array.isArray(snap.locations) ? snap.locations : [],
    trend: Array.isArray(snap.trend) ? snap.trend : [],
    fromCache: true,
  }
}

function DashboardPage() {
  const { showToast } = useToast()
  const initial = useMemo(() => hydrateDashboard(), [])
  const [overview, setOverview] = useState(initial.overview)
  const [channels, setChannels] = useState(initial.channels)
  const [topFiveChannels, setTopFiveChannels] = useState(initial.topFiveChannels)
  const [channelLabels, setChannelLabels] = useState(initial.channelLabels)
  const [locations, setLocations] = useState(initial.locations)
  const [trend, setTrend] = useState(initial.trend)
  const [loaded, setLoaded] = useState(initial.fromCache)
  const [refreshing, setRefreshing] = useState(false)
  const loadGenRef = useRef(0)

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    const hadData = loaded || initial.fromCache
    if (hadData) setRefreshing(true)
    try {
      const [snap, t, deviceSummary] = await Promise.all([
        getAnalyticsSnapshot(),
        getAnalyticsTrend(),
        fetchDeviceIntelligenceSummary().catch(() => null),
      ])
      if (gen !== loadGenRef.current) return
      if (isDegradedAnalyticsSnapshot(snap)) {
        // Registry total is authoritative for the Unique Devices card — still apply it.
        const registryTotal = Number(deviceSummary?.totalDevicesEverSeen)
        if (Number.isFinite(registryTotal) && registryTotal >= 0) {
          setOverview((prev) => ({ ...prev, totalUniqueDevices: registryTotal }))
        }
        showToast('error', snap?.error || 'Dashboard refresh degraded — keeping last data')
        setLoaded(true)
        return
      }
      const registryTotal = Number(deviceSummary?.totalDevicesEverSeen)
      const nextOverview = {
        onlineNow: snap?.onlineNow,
        watchingNow: snap?.watchingNow,
        idleNow: snap?.idleNow,
        // Authoritative: Users Intelligence device_intelligence_registry (not analytics census).
        totalUniqueDevices: Number.isFinite(registryTotal) && registryTotal >= 0
          ? registryTotal
          : readCachedUniqueDevicesTotal() ?? 0,
        revenueToday: snap?.revenueToday,
        newUsersToday: snap?.newUsersToday,
        dauToday: snap?.dauToday,
        livePresenceWindowSeconds: snap?.livePresenceWindowSeconds,
      }
      const nextChannels = Array.isArray(snap?.mostWatched) ? snap.mostWatched : []
      const nextTopFive = Array.isArray(snap?.top5) ? snap.top5 : []
      const nextLabels =
        snap?.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {}
      const nextLocations = Array.isArray(snap?.locations) ? snap.locations : []
      const nextTrend = Array.isArray(t)
        ? t.map((x) => ({
            time: new Date(x.time).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'Africa/Dar_es_Salaam',
            }),
            users: Number(x.users) || 0,
          }))
        : null

      setOverview((prev) => ({ ...prev, ...nextOverview }))
      if (nextChannels.length > 0 || nextTopFive.length > 0) {
        setChannels(nextChannels)
        setTopFiveChannels(nextTopFive)
        setChannelLabels(nextLabels)
      }
      if (nextLocations.length > 0) setLocations(nextLocations)
      if (Array.isArray(nextTrend)) setTrend(nextTrend)

      writeAdminSnapshot('dashboard', {
        overview: nextOverview,
        channels: nextChannels,
        topFiveChannels: nextTopFive,
        channelLabels: nextLabels,
        locations: nextLocations,
        trend: Array.isArray(nextTrend) ? nextTrend : trend,
      })
      setLoaded(true)
    } catch (e) {
      if (gen !== loadGenRef.current) return
      showToast('error', e?.message || 'Could not load dashboard')
      setLoaded(true)
    } finally {
      if (gen === loadGenRef.current) setRefreshing(false)
    }
  }, [showToast, loaded, initial.fromCache])

  useAnalyticsLiveRefresh(load, { pollMs: 15_000 })

  const uniqueDevicesFormatted = useMemo(() => {
    const n = Number(overview?.totalUniqueDevices)
    if (!Number.isFinite(n) || n <= 0) return '0'
    return n.toLocaleString('en-TZ')
  }, [overview])

  const channelNameById = useMemo(() => new Map(Object.entries(channelLabels)), [channelLabels])

  const mostWatched = useMemo(() => {
    return (Array.isArray(channels) ? channels : []).map((r) => ({
      id: String(r.channel_id ?? ''),
      name:
        channelNameById.get(String(r.channel_id ?? '').trim()) ||
        String(r.channel_id ?? 'Unknown Channel'),
      watchers: Number(r.viewers) || 0,
    }))
  }, [channels, channelNameById])

  const topFiveEligible = useMemo(() => {
    const rows = Array.isArray(topFiveChannels) ? topFiveChannels : []
    return rows.map((r) => ({
      id: String(r.channel_id ?? ''),
      name:
        channelNameById.get(String(r.channel_id ?? '').trim()) ||
        String(r.channel_id ?? 'Unknown Channel'),
      watchers: Number(r.viewers) || 0,
    }))
  }, [channelNameById, topFiveChannels])

  const section1Cards = [
    {
      gradientClass: emerald,
      className: 'dashboard-card',
      title: 'Total Unique Devices',
      value: uniqueDevicesFormatted,
      icon: Activity,
    },
  ]

  return (
    <>
      <Topbar />

      <main className="mt-6">
        <div className="overflow-x-auto">
          <section className="dashboard-grid">
            <StatCard key={`top-${section1Cards[0].title}`} {...section1Cards[0]} />
            <MostWatchedChannelsListCard channels={mostWatched} />
            <MostWatchedChannelsCard channels={topFiveEligible} />
            <LiveUserLocationsCard
              locations={locations}
              totalOnline={Number(overview?.onlineNow) || 0}
              watchingNow={Number(overview?.watchingNow) || 0}
              idleNow={Number(overview?.idleNow) || 0}
            />
          </section>
        </div>
        <LiveUsersTrendSection points={trend} />
        {!loaded ? (
          <p className="mt-3 text-xs text-slate-500">Loading dashboard…</p>
        ) : refreshing ? (
          <p className="mt-3 text-xs text-slate-500">Refreshing dashboard…</p>
        ) : null}
      </main>
    </>
  )
}

export default DashboardPage
