import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import LiveUserLocationsCard from '../components/LiveUserLocationsCard'
import LiveUsersTrendSection from '../components/LiveUsersTrendSection'
import MostWatchedChannelsCard from '../components/MostWatchedChannelsCard'
import MostWatchedChannelsListCard from '../components/MostWatchedChannelsListCard'
import StatCard from '../components/StatCard'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  getAnalyticsChannels,
  getAnalyticsLocations,
  getAnalyticsOverview,
  getChannels,
  syncStreamUrl,
  getAnalyticsTrend,
} from '../lib/api'

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
  const [channelCatalog, setChannelCatalog] = useState([])
  const [locations, setLocations] = useState([])
  const [trend, setTrend] = useState([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const [o, c, l, t, catalog] = await Promise.all([
        getAnalyticsOverview(),
        getAnalyticsChannels(),
        getAnalyticsLocations(),
        getAnalyticsTrend(),
        getChannels(),
      ])
      setOverview((o && typeof o === 'object' ? o : null) || OVERVIEW_FALLBACK)
      setChannels(Array.isArray(c?.mostWatched) ? c.mostWatched : [])
      setTopFiveChannels(Array.isArray(c?.top5) ? c.top5 : [])
      setChannelCatalog(Array.isArray(catalog) ? catalog : [])
      setLocations(Array.isArray(l) ? l : [])
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
      setOverview({})
      setChannels([])
      setTopFiveChannels([])
      setChannelCatalog([])
      setLocations([])
      setTrend([])
      setLoaded(true)
    }
  }, [showToast])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 3000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics']))
    const onSync = () => {
      void load()
    }
    es.addEventListener('snapshot', onSync)
    es.addEventListener('analytics.install', onSync)
    es.addEventListener('analytics.install_reset', onSync)
    es.addEventListener('analytics.reset', onSync)
    es.addEventListener('analytics.session_start', onSync)
    es.addEventListener('analytics.session_heartbeat', onSync)
    es.addEventListener('analytics.session_end', onSync)
    es.addEventListener('analytics.presence_expired', onSync)
    es.addEventListener('analytics.transaction_updated', onSync)
    es.addEventListener('analytics.subscription_updated', onSync)
    return () => {
      es.close()
    }
  }, [load])

  const installsFormatted = useMemo(() => {
    const n = Number(overview?.totalInstalls)
    if (!Number.isFinite(n) || n <= 0) return '0'
    return n.toLocaleString('en-TZ')
  }, [overview])

  const channelNameById = useMemo(() => {
    const m = new Map()
    for (const row of Array.isArray(channelCatalog) ? channelCatalog : []) {
      const id = String(row?.id ?? '').trim()
      const name = String(row?.name ?? '').trim()
      if (!id) continue
      m.set(id, name || id)
    }
    return m
  }, [channelCatalog])

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
            <LiveUserLocationsCard locations={locations} />
          </section>
        </div>
        <LiveUsersTrendSection points={trend} />
        {!loaded ? <p className="mt-3 text-xs text-slate-500">Loading dashboard…</p> : null}
      </main>
    </>
  )
}

export default DashboardPage
