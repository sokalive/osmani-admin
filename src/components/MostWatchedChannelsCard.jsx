import { useMemo } from 'react'

function rankRowClass(rank) {
  const base =
    'rounded-xl border border-white/[0.06] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  if (rank === 1) {
    return `${base} bg-gradient-to-br from-red-600/45 via-red-900/25 to-red-950/40`
  }
  if (rank === 2) {
    return `${base} bg-gradient-to-br from-purple-600/45 via-purple-900/25 to-purple-950/40`
  }
  if (rank === 3) {
    return `${base} bg-gradient-to-br from-blue-600/45 via-blue-900/25 to-blue-950/40`
  }
  return `${base} bg-slate-900/75`
}

/**
 * Top 5 channels — `.dashboard-card` + `.card-header` + `.card-content` scroll.
 */
function MostWatchedChannelsCard({ channels, className = 'dashboard-card' }) {
  const topFive = useMemo(
    () => [...channels].sort((a, b) => b.watchers - a.watchers).slice(0, 5),
    [channels],
  )

  return (
    <article
      className={`border border-[rgba(255,255,255,0.05)] shadow-[0_8px_25px_rgba(0,0,0,0.5)] ${className}`}
      style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #111827 40%, #1e293b 100%)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <div className="card-header border-b border-slate-800/90 pb-3">
        <h2 className="text-base font-bold tracking-tight text-white">Top 5 Channels</h2>
      </div>

      <div className="card-content">
        <ul className="channel-list">
          {topFive.map((row, index) => {
            const rank = index + 1
            return (
              <li key={row.id} className={rankRowClass(rank)}>
                <p className="font-bold leading-snug text-white">
                  <span className="tabular-nums text-white">#{rank}</span>{' '}
                  <span>{row.name}</span>
                </p>
                <p className="mt-1 text-[13px] font-medium tabular-nums leading-snug text-white/70">
                  {row.watchers.toLocaleString()} active watchers
                </p>
              </li>
            )
          })}
        </ul>
      </div>
    </article>
  )
}

export default MostWatchedChannelsCard
