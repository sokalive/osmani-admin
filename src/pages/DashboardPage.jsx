import { useCallback, useMemo, useState } from 'react'
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

const emerald =
  'bg-gradient-to-br from-emerald-400/92 via-emerald-500/88 to-emerald-700/90'

const OVERVIEW_FALLBACK = {
  onlineNow: 0,
  totalInstalls: 0,
  revenueToday: 0,
  newUsersToday: 0,
}

function DashboardPage() {
  const { showToast } = useToast()
  const [overview, setOverview] = useState(OVERVIEW_FALLBACK)
  const [channels, setChannels] = useState([])
  const [topFiveChannels, setTopFiveChannels] = useState([])
  const [channelLabels, setChannelLabels] = useState({})
  const [locations, setLocations] = useState([])
  const [trend, setTrend] = useState([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const [snap, t] = await Promise.all([getAnalyticsSnapshot(), getAnalyticsTrend()])
      setOverview({
        onlineNow: snap?.onlineNow,
        totalInstalls: snap?.totalInstalls,
        revenueToday: snap?.revenueToday,
        newUsersToday: snap?.newUsersToday,
        dauToday: snap?.dauToday,
        livePresenceWindowSeconds: snap?.livePresenceWindowSeconds,
      })
      setChannels(Array.isArray(snap?.mostWatched) ? snap.mostWatched : [])
      setTopFiveChannels(Array.isArray(snap?.top5) ? snap.top5 : [])
      setChannelLabels(
        snap?.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {},
      )
      setLocations(Array.isArray(snap?.locations) ? snap.locations : [])
      setTrend(
        Array.isArray(t)
          ? t.map((x) => ({
              time: new Date(x.time).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'Africa/Dar_es_Salaam',
              }),
              users: Number(x.users) || 0,
            }))
          : [],
      )
      setLoaded(true)
    } catch (e) {
      showToast('error', e?.message || 'Could not load dashboard')
      setLoaded(true)
    }
  }, [showToast])

  useAnalyticsLiveRefresh(load, { pollMs: 15_000 })

  const installsFormatted = useMemo(() => {
    const n = Number(overview?.totalInstalls)
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
      title: 'Total App Installs',
      value: installsFormatted,
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
            />
          </section>
        </div>
        <LiveUsersTrendSection points={trend} />
        {!loaded ? <p className="mt-3 text-xs text-slate-500">Loading dashboard…</p> : null}
      </main>
    </>
  )
}

export default DashboardPage
