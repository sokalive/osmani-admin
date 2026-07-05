import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Banknote,
  Download,
  Globe,
  Radio,
  RefreshCw,
  UserPlus,
} from 'lucide-react'
import Topbar from '../components/Topbar'
import InstallsGrowthChart from '../components/InstallsGrowthChart'
import { LiveLocationRowList, normalizePlaceRows } from '../components/LiveUserLocationsCard'
import ResetInstallAnalyticsPanel from '../components/ResetInstallAnalyticsPanel'
import { useToast } from '../context/ToastContext.jsx'
import { useAnalyticsLiveRefresh } from '../hooks/useAnalyticsLiveRefresh.js'
import {
  getAnalyticsSnapshot,
  getAnalyticsTrend,
} from '../lib/api'
import { formatTsh } from '../lib/formatMoney'
import { useCountUp } from '../hooks/useCountUp'
import { isDegradedAnalyticsSnapshot } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

function hydrateAnalytics() {
  const snap = readAdminSnapshot('analytics')
  if (!snap || typeof snap !== 'object') {
    return { overview: {}, channels: [], channelLabels: {}, locations: [], trend: [], fromCache: false }
  }
  return {
    overview: snap.overview && typeof snap.overview === 'object' ? snap.overview : {},
    channels: Array.isArray(snap.channels) ? snap.channels : [],
    channelLabels: snap.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {},
    locations: Array.isArray(snap.locations) ? snap.locations : [],
    trend: Array.isArray(snap.trend) ? snap.trend : [],
    fromCache: true,
  }
}

function MetricCard({ title, display, icon: Icon, gradientClass, sub }) {
  return (
    <article
      className={`relative flex min-h-[140px] flex-col justify-between overflow-hidden rounded-2xl border border-white/10 p-5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.28)] ${gradientClass}`}
    >
      <div className="pointer-events-none absolute -right-4 -top-4 h-24 w-24 rounded-full bg-white/10 blur-2xl" />
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="rounded-xl bg-black/20 p-2.5">
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
      <div className="relative z-10 mt-3 min-w-0">
        <p className="text-2xl font-extrabold tabular-nums tracking-tight sm:text-[1.65rem]">
          {display}
        </p>
        <p className="mt-1 text-xs font-medium text-white/85">{title}</p>
        {sub ? <p className="mt-0.5 text-[11px] text-white/65">{sub}</p> : null}
      </div>
    </article>
  )
}

function AnalyticsPage() {
  const { showToast } = useToast()
  const initial = useMemo(() => hydrateAnalytics(), [])
  const loadGenRef = useRef(0)
  const [overview, setOverview] = useState(initial.overview)
  const [channels, setChannels] = useState(initial.channels)
  const [channelLabels, setChannelLabels] = useState(initial.channelLabels)
  const [locations, setLocations] = useState(initial.locations)
  const [trend, setTrend] = useState(initial.trend)
  const [isLoading, setIsLoading] = useState(!initial.fromCache)
  const [error, setError] = useState('')
  const [isDegraded, setIsDegraded] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [loaded, setLoaded] = useState(initial.fromCache)

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    try {
      setError('')
      const [snap, t] = await Promise.all([
        getAnalyticsSnapshot(),
        getAnalyticsTrend(),
      ])
      if (gen !== loadGenRef.current) return
      if (isDegradedAnalyticsSnapshot(snap)) {
        setIsDegraded(true)
        setLoaded(true)
        setIsLoading(false)
        return
      }
      const nextOverview = snap && typeof snap === 'object' ? snap : {}
      const nextChannels = Array.isArray(snap?.mostWatched) ? snap.mostWatched : []
      const nextLabels =
        snap?.channelLabels && typeof snap.channelLabels === 'object' ? snap.channelLabels : {}
      const nextLocations = Array.isArray(snap?.locations) ? snap.locations : []
      const nextTrend = Array.isArray(t) ? t : []
      setOverview((prev) => ({ ...prev, ...nextOverview }))
      if (nextChannels.length > 0) setChannels(nextChannels)
      if (Object.keys(nextLabels).length > 0) setChannelLabels(nextLabels)
      if (nextLocations.length > 0) setLocations(nextLocations)
      if (nextTrend.length > 0) setTrend(nextTrend)
      writeAdminSnapshot('analytics', {
        overview: nextOverview,
        channels: nextChannels,
        channelLabels: nextLabels,
        locations: nextLocations,
        trend: nextTrend,
      })
      setIsDegraded(Boolean(snap?.degraded))
      setLastUpdated(new Date())
      setLoaded(true)
    } catch (e) {
      if (gen !== loadGenRef.current) return
      showToast('error', e?.message || 'Could not load analytics')
      setError(e?.message || 'Could not load analytics')
      setLoaded(true)
      setIsDegraded(false)
    } finally {
      if (gen === loadGenRef.current) setIsLoading(false)
    }
  }, [showToast])

  useAnalyticsLiveRefresh(load, { pollMs: 15_000 })

  const onlineNow = Number(overview?.onlineNow) || 0
  const watchingNow = Number(overview?.watchingNow) || 0
  const idleNow = Number(overview?.idleNow) || 0
  const newUsersToday = Number(overview?.newUsersToday) || 0
  const revenueTodayValue = Number(overview?.revenueToday) || 0
  const totalInstallsBase = Number(overview?.totalInstalls) || 0
  const dauToday = Number(overview?.dauToday) || 0
  const txRevenueToday = revenueTodayValue

  const chartShort = useMemo(() => {
    const rows = Array.isArray(trend) ? trend : []
    const sliced = rows.slice(Math.max(0, rows.length - 12))
    return sliced.map((r) => ({
      label: new Date(r.time).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Africa/Dar_es_Salaam',
      }),
      installs: Number(r.users) || 0,
    }))
  }, [trend])

  const chartLong = useMemo(() => {
    const rows = Array.isArray(trend) ? trend : []
    const sliced = rows.slice(Math.max(0, rows.length - 96))
    return sliced.map((r) => ({
      label: new Date(r.time).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Africa/Dar_es_Salaam',
      }),
      installs: Number(r.users) || 0,
    }))
  }, [trend])

  const topContent = useMemo(
    () => {
      const nameById = new Map(Object.entries(channelLabels))
      return (Array.isArray(channels) ? channels : []).slice(0, 8).map((r) => ({
        id: String(r.channel_id ?? ''),
        title:
          nameById.get(String(r.channel_id ?? '').trim()) ||
          String(r.channel_id ?? 'Unknown Channel'),
        views: Number(r.viewers) || 0,
        bar: 100,
      }))
    },
    [channelLabels, channels],
  )

  const vOnline = useCountUp(onlineNow, { duration: 900 })
  const vNewUsers = useCountUp(newUsersToday, { duration: 900 })
  const vDau = useCountUp(dauToday, { duration: 1100 })
  const vRev = useCountUp(revenueTodayValue, { duration: 1000 })
  const vInstalls = useCountUp(totalInstallsBase, { duration: 1200 })

  const topLocations = useMemo(() => normalizePlaceRows(locations), [locations])

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Analytics</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <p>Audience, installs, and revenue derived from live analytics API.</p>
            {lastUpdated ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-2 py-0.5 text-xs">
                <RefreshCw className="h-3 w-3" />
                Updated {lastUpdated.toLocaleTimeString('en-GB')}
              </span>
            ) : null}
          </div>
          {isDegraded ? (
            <p className="mt-2 inline-flex w-fit items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              Backend returned degraded analytics data.
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 inline-flex w-fit items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </p>
          ) : null}
        </header>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            title="Online Now"
            display={vOnline.toLocaleString('en-TZ')}
            icon={Radio}
            gradientClass="bg-gradient-to-br from-cyan-400/95 via-teal-600/95 to-slate-900/95"
            sub={
              watchingNow > 0 || idleNow > 0
                ? `${watchingNow.toLocaleString('en-TZ')} watching · ${idleNow.toLocaleString('en-TZ')} idle`
                : 'Active live sessions within runtime TTL'
            }
          />
          <MetricCard
            title="New Subscriptions Today"
            display={vNewUsers.toLocaleString('en-TZ')}
            icon={UserPlus}
            gradientClass="bg-gradient-to-br from-violet-400/95 via-purple-700/95 to-slate-900/95"
            sub="Started device subscriptions today"
          />
          <MetricCard
            title="Live Devices Today"
            display={vDau.toLocaleString('en-TZ')}
            icon={Activity}
            gradientClass="bg-gradient-to-br from-emerald-400/95 via-emerald-700/95 to-slate-900/95"
            sub="Distinct live devices today"
          />
          <MetricCard
            title="Revenue Today"
            display={formatTsh(vRev)}
            icon={Banknote}
            gradientClass="bg-gradient-to-br from-amber-400/95 via-orange-700/95 to-slate-900/95"
            sub={txRevenueToday > 0 ? 'Completed transactions today' : 'No completed transactions today'}
          />
          <MetricCard
            title="Total Installs"
            display={vInstalls.toLocaleString('en-TZ')}
            icon={Download}
            gradientClass="bg-gradient-to-br from-rose-400/95 via-fuchsia-800/95 to-slate-900/95"
            sub="From app install records"
          />
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <InstallsGrowthChart
            title="App installs growth (recent)"
            subtitle="Last ~12 buckets · cumulative installs"
            chartId="recent"
            data={chartShort}
            emptyLabel={isLoading && !loaded ? 'Loading install trend…' : 'No install data yet.'}
          />
          <InstallsGrowthChart
            title="App installs growth (24h)"
            subtitle="Last ~96 buckets · cumulative installs"
            chartId="24h"
            data={chartLong}
            emptyLabel={isLoading && !loaded ? 'Loading install trend…' : 'No install data yet.'}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-lg font-semibold text-white">Top watched channels</h2>
            <p className="mt-1 text-sm text-slate-500">Ranked by active live sessions</p>
            <ul className="mt-5 space-y-4">
              {topContent.length === 0 ? (
                <li className="text-sm text-slate-500">
                  {isLoading && !loaded ? 'Loading channel analytics...' : 'No live channel analytics yet.'}
                </li>
              ) : (
                topContent.map((row) => (
                  <li key={row.id}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
                        {row.title}
                      </span>
                      <span className="shrink-0 tabular-nums text-amber-200/95">
                        {row.views.toLocaleString('en-TZ')} users
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 transition-all duration-500"
                        style={{ width: `${row.bar}%` }}
                      />
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-white">
              <Globe className="h-5 w-5 text-cyan-300" />
              Live locations
            </h2>
            <p className="mt-1 text-sm text-slate-500">Active users grouped by city or region</p>
            <div className="mt-5">
              <LiveLocationRowList rows={topLocations} />
            </div>
          </section>
        </div>

        <ResetInstallAnalyticsPanel onResetComplete={load} />
      </main>
    </>
  )
}

export default AnalyticsPage
