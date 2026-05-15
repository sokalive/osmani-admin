import { useMemo } from 'react'
import { TrendingUp } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  computeChartYAxis,
  computeInstallSeriesStats,
  formatChartCountTick,
} from '../lib/chartFormat'

/** Full-width analytics-style panel below dashboard cards. */
function LiveUsersTrendSection({ points }) {
  const data = Array.isArray(points) ? points : []
  const stats = useMemo(
    () => computeInstallSeriesStats(data.map((d) => ({ installs: Number(d.users) || 0 })), 'installs'),
    [data],
  )
  const yAxis = useMemo(
    () => computeChartYAxis(data.map((d) => Number(d.users) || 0)),
    [data],
  )

  return (
    <section
      className="mt-6 w-full max-w-full shrink-0"
      aria-labelledby="live-users-trend-heading"
    >
      <article
        className="box-border w-full rounded-[20px] border border-slate-600/35 bg-gradient-to-b from-[#0f172a] to-[#020617] p-4 shadow-[0_12px_28px_rgba(0,0,0,0.22)] sm:p-5"
        style={{ minHeight: '420px' }}
      >
        <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2
              id="live-users-trend-heading"
              className="text-lg font-bold tracking-tight text-[#FFFFFF] sm:text-xl"
            >
              App Installs Growth
            </h2>
            <p className="mt-1 text-xs text-[#BFC7D5]">
              Total {stats.total.toLocaleString('en-US')} installs
              {stats.growthPct != null ? (
                <span className="ml-2 text-emerald-300">
                  <TrendingUp className="mr-0.5 inline h-3.5 w-3.5" />
                  {stats.growthPct >= 0 ? '+' : ''}
                  {stats.growthPct.toFixed(1)}%
                </span>
              ) : null}
            </p>
          </div>
        </div>

        <div className="h-[min(380px,calc(100vw-4rem))] w-full min-h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 8, right: 8, left: 4, bottom: 4 }}
            >
              <defs>
                <linearGradient id="liveTrendStroke" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#a855f7" />
                  <stop offset="55%" stopColor="#d946ef" />
                  <stop offset="100%" stopColor="#ec4899" />
                </linearGradient>
                <linearGradient id="liveTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c084fc" stopOpacity={0.35} />
                  <stop offset="45%" stopColor="#e879f9" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#ec4899" stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="4 8"
                vertical={false}
              />

              <XAxis
                dataKey="time"
                tick={{ fill: '#BFC7D5', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
              />

              <YAxis
                domain={yAxis.domain}
                ticks={yAxis.ticks}
                tickFormatter={formatChartCountTick}
                tick={{ fill: '#BFC7D5', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                width={48}
              />

              <Tooltip
                contentStyle={{
                  background: '#111827',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px',
                  color: '#FFFFFF',
                }}
                labelStyle={{ color: '#BFC7D5' }}
                formatter={(value) => [
                  `${Number(value).toLocaleString()} installs`,
                  'Total installs',
                ]}
              />

              <Area
                type="monotone"
                dataKey="users"
                stroke="url(#liveTrendStroke)"
                strokeWidth={2.5}
                fill="url(#liveTrendFill)"
                fillOpacity={1}
                isAnimationActive
                animationDuration={1200}
                animationEasing="ease-out"
                dot={false}
                activeDot={{ r: 4, fill: '#f472b6', stroke: '#fff', strokeWidth: 1 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </article>
    </section>
  )
}

export default LiveUsersTrendSection
