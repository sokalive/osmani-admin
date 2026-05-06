import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

/** Full-width analytics-style panel below dashboard cards. */
function LiveUsersTrendSection({ points }) {
  const data = Array.isArray(points) ? points : []

  const yDomain = useMemo(() => {
    if (!data.length) return [0, 100]
    const vals = data.map((d) => Number(d.users) || 0)
    const min = Math.min(...vals, 0)
    const max = Math.max(...vals, 100)
    const pad = (max - min) * 0.15 || 20000
    return [Math.floor(min - pad), Math.ceil(max + pad)]
  }, [data])

  return (
    <section
      className="mt-6 w-full max-w-full shrink-0"
      aria-labelledby="live-users-trend-heading"
    >
      <article
        className="box-border w-full rounded-[20px] border border-slate-600/35 bg-gradient-to-b from-[#0f172a] to-[#020617] p-4 shadow-[0_12px_28px_rgba(0,0,0,0.22)] sm:p-5"
        style={{ minHeight: '420px' }}
      >
        <h2
          id="live-users-trend-heading"
          className="mb-4 text-lg font-bold tracking-tight text-[#FFFFFF] sm:mb-5 sm:text-xl"
        >
          Live Users Trend
        </h2>

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
                domain={yDomain}
                tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                tick={{ fill: '#BFC7D5', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                width={44}
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
                  `${Number(value).toLocaleString()} users`,
                  'Live users',
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
