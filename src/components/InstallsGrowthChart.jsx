import { useMemo } from 'react'
import { TrendingDown, TrendingUp } from 'lucide-react'
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

function GrowthBadge({ stats }) {
  if (stats.points < 2) {
    return (
      <span className="rounded-full border border-slate-600/60 bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-400">
        Not enough data
      </span>
    )
  }
  const up = stats.delta >= 0
  const pct =
    stats.growthPct == null
      ? '—'
      : `${stats.growthPct >= 0 ? '+' : ''}${stats.growthPct.toFixed(1)}%`
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${
        up
          ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/35'
          : 'bg-red-500/15 text-red-200 ring-red-400/35'
      }`}
    >
      {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      {pct} growth
    </span>
  )
}

/**
 * Cumulative installs area chart — frontend-only; API data unchanged.
 */
function InstallsGrowthChart({ title, subtitle, chartId, data, emptyLabel = 'No install data yet.' }) {
  const series = Array.isArray(data) ? data : []
  const stats = useMemo(() => computeInstallSeriesStats(series, 'installs'), [series])
  const yAxis = useMemo(
    () => computeChartYAxis(series.map((r) => r.installs)),
    [series],
  )
  const gid = `installs-${chartId}`

  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-950/50 p-5 ring-1 ring-white/[0.04]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        <GrowthBadge stats={stats} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Total installs</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-white">
            {stats.total.toLocaleString('en-US')}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Period start</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-200">
            {stats.start.toLocaleString('en-US')}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Period end</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-200">
            {stats.end.toLocaleString('en-US')}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Net change</p>
          <p
            className={`mt-1 text-lg font-bold tabular-nums ${
              stats.delta >= 0 ? 'text-emerald-300' : 'text-red-300'
            }`}
          >
            {stats.delta >= 0 ? '+' : ''}
            {stats.delta.toLocaleString('en-US')}
          </p>
        </div>
      </div>

      <div className="mt-5 h-[300px] w-full sm:h-[320px]">
        {series.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-700/60 bg-slate-900/30 text-sm text-slate-500">
            {emptyLabel}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 12, right: 12, left: 4, bottom: 8 }}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.4} />
                  <stop offset="55%" stopColor="#f59e0b" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 8" stroke="#334155" opacity={0.35} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#475569' }}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                domain={yAxis.domain}
                ticks={yAxis.ticks}
                tickFormatter={formatChartCountTick}
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#475569' }}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  background: '#0f172a',
                  border: '1px solid rgba(251,191,36,0.35)',
                  borderRadius: '12px',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
                }}
                labelStyle={{ color: '#cbd5e1', marginBottom: 4 }}
                formatter={(val) => [
                  `${Number(val).toLocaleString('en-US')} installs`,
                  'Cumulative',
                ]}
              />
              <Area
                type="monotone"
                dataKey="installs"
                stroke="#fbbf24"
                strokeWidth={2.5}
                fill={`url(#${gid})`}
                dot={false}
                activeDot={{ r: 5, fill: '#fde047', stroke: '#0f172a', strokeWidth: 2 }}
                isAnimationActive
                animationDuration={800}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

export default InstallsGrowthChart
