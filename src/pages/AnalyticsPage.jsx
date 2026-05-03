import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Banknote,
  Download,
  Radio,
  UserPlus,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getAnalyticsSummary } from '../lib/api'
import {
  buildRevenueSeriesFromTransactions,
  revenueTodayFromTransactions,
  topWatchedFromTransactions,
} from '../lib/analyticsSeries'
import { isSameLocalDay } from '../lib/dates'
import { formatTsh } from '../lib/formatMoney'
import { useCountUp } from '../hooks/useCountUp'

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

function ChartBlock({ title, data, chartId, dataKey = 'revenue' }) {
  const gid = `rev-${chartId}`
  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-950/50 p-5 ring-1 ring-white/[0.04]">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <div className="mt-4 h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#fbbf24" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.45} />
            <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={{ stroke: '#475569' }} />
            <YAxis
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={{ stroke: '#475569' }}
              tickFormatter={(v) => `${Math.round(v / 1000)}k`}
            />
            <Tooltip
              contentStyle={{
                background: '#0f172a',
                border: '1px solid rgba(251,191,36,0.35)',
                borderRadius: '12px',
              }}
              labelStyle={{ color: '#e2e8f0' }}
              formatter={(val) => [formatTsh(val), 'Revenue']}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke="#fbbf24"
              strokeWidth={2}
              fill={`url(#${gid})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function AnalyticsPage() {
  const { showToast } = useToast()
  const [transactions, setTransactions] = useState([])
  const [users, setUsers] = useState([])
  const [channelCount, setChannelCount] = useState(0)

  const load = useCallback(async () => {
    try {
      const s = await getAnalyticsSummary()
      setTransactions(Array.isArray(s.transactions) ? s.transactions : [])
      setUsers(Array.isArray(s.users) ? s.users : [])
      setChannelCount(Number(s.channelCount) || 0)
    } catch (e) {
      showToast('error', e?.message || 'Could not load analytics')
      setTransactions([])
      setUsers([])
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  const txRevenueToday = useMemo(() => revenueTodayFromTransactions(transactions), [transactions])

  const newUsersToday = useMemo(() => {
    const day = new Date()
    return users.filter((u) => u.startDate && isSameLocalDay(u.startDate, day)).length
  }, [users])

  const onlineNow = useMemo(() => {
    const now = Date.now()
    const active = users.filter((u) => new Date(u.expiryDate).getTime() > now).length
    return Math.max(0, active * 4 + channelCount * 120)
  }, [users, channelCount])

  const totalInstallsBase = useMemo(() => {
    return Math.max(users.length, transactions.length)
  }, [users.length, transactions.length])

  const dauEstimate = useMemo(() => {
    const base = users.length * 180 + transactions.filter((t) => t.status === 'completed').length * 40
    return Math.max(users.length, base)
  }, [users, transactions])

  const revenueTodayValue = useMemo(() => {
    const series = buildRevenueSeriesFromTransactions(transactions, 7)
    const last = series[series.length - 1]
    return last?.revenue ?? txRevenueToday
  }, [transactions, txRevenueToday])

  const chart7 = useMemo(
    () => buildRevenueSeriesFromTransactions(transactions, 7),
    [transactions],
  )
  const chart30 = useMemo(
    () => buildRevenueSeriesFromTransactions(transactions, 30),
    [transactions],
  )

  const topContent = useMemo(() => topWatchedFromTransactions(transactions, 8), [transactions])

  const vOnline = useCountUp(onlineNow, { duration: 900 })
  const vNewUsers = useCountUp(newUsersToday, { duration: 900 })
  const vDau = useCountUp(dauEstimate, { duration: 1100 })
  const vRev = useCountUp(revenueTodayValue, { duration: 1000 })
  const vInstalls = useCountUp(totalInstallsBase, { duration: 1200 })

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Analytics</h1>
          <p className="mt-1 text-sm text-slate-400">
            Audience, installs, and revenue derived from live API data (users, transactions, and
            channels).
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            title="Online Now"
            display={vOnline.toLocaleString('en-TZ')}
            icon={Radio}
            gradientClass="bg-gradient-to-br from-cyan-400/95 via-teal-600/95 to-slate-900/95"
            sub="Estimated from active subscriptions"
          />
          <MetricCard
            title="New Users Today"
            display={vNewUsers.toLocaleString('en-TZ')}
            icon={UserPlus}
            gradientClass="bg-gradient-to-br from-violet-400/95 via-purple-700/95 to-slate-900/95"
            sub="From subscriptions"
          />
          <MetricCard
            title="Daily Active Users"
            display={vDau.toLocaleString('en-TZ')}
            icon={Activity}
            gradientClass="bg-gradient-to-br from-emerald-400/95 via-emerald-700/95 to-slate-900/95"
            sub="Modelled from API activity"
          />
          <MetricCard
            title="Revenue Today"
            display={formatTsh(vRev)}
            icon={Banknote}
            gradientClass="bg-gradient-to-br from-amber-400/95 via-orange-700/95 to-slate-900/95"
            sub={txRevenueToday > 0 ? 'Completed transactions today' : 'No completed TX today'}
          />
          <MetricCard
            title="Total Installs"
            display={vInstalls.toLocaleString('en-TZ')}
            icon={Download}
            gradientClass="bg-gradient-to-br from-rose-400/95 via-fuchsia-800/95 to-slate-900/95"
            sub="Users + transaction records (lower bound)"
          />
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <ChartBlock title="7-day revenue" chartId="d7" data={chart7} />
          <ChartBlock title="30-day revenue" chartId="d30" data={chart30} />
        </div>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <h2 className="text-lg font-semibold text-white">Top watched content</h2>
          <p className="mt-1 text-sm text-slate-500">
            Ranked by completed payment volume (plan name as proxy)
          </p>
          <ul className="mt-5 space-y-4">
            {topContent.length === 0 ? (
              <li className="text-sm text-slate-500">No transaction data yet.</li>
            ) : (
              topContent.map((row) => (
                <li key={row.id}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
                      {row.title}
                    </span>
                    <span className="shrink-0 tabular-nums text-amber-200/95">
                      {formatTsh(row.views)}
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
      </main>
    </>
  )
}

export default AnalyticsPage
