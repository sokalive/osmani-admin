import { useMemo } from 'react'

function rankRowClass(rank) {
  const base = 'dashboard-top5-row'
  if (rank === 1) {
    return `${base} dashboard-top5-rank-1`
  }
  if (rank === 2) {
    return `${base} dashboard-top5-rank-2`
  }
  if (rank === 3) {
    return `${base} dashboard-top5-rank-3`
  }
  return `${base} dashboard-top5-rank-other`
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
        {topFive.length === 0 ? (
          <p className="px-1 py-2 text-sm text-slate-500">
            No channel has 10+ concurrent viewers yet.
          </p>
        ) : (
          <ul className="channel-list dashboard-top5-list">
            {topFive.map((row, index) => {
              const rank = index + 1
              return (
                <li key={row.id} className={rankRowClass(rank)}>
                  <p className="dashboard-top5-title">
                    <span className="tabular-nums text-white">#{rank}</span>{' '}
                    <span>{row.name}</span>
                  </p>
                  <p className="dashboard-top5-meta mt-1 tabular-nums">
                    {row.watchers.toLocaleString()} active live sessions
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </article>
  )
}

export default MostWatchedChannelsCard
