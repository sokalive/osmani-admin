import { useMemo } from 'react'
import { Eye } from 'lucide-react'

/**
 * Full channel list + red watcher pills — uses global `.dashboard-card` sizing.
 */
function MostWatchedChannelsListCard({ channels, className = 'dashboard-card' }) {
  const sorted = useMemo(
    () => [...channels].sort((a, b) => b.watchers - a.watchers),
    [channels],
  )

  return (
    <article
      className={`border border-slate-600/35 shadow-[0_12px_28px_rgba(0,0,0,0.22)] ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0f172a 0%, #020617 100%)',
      }}
    >
      <div className="card-header flex items-center gap-2 border-b border-slate-700/60 pb-3">
        <Eye className="h-5 w-5 shrink-0 text-white" aria-hidden />
        <h2 className="text-base font-bold tracking-tight text-white">Most Watched Channels</h2>
      </div>

      <div className="card-content">
        {sorted.length === 0 ? (
          <p className="px-1 py-2 text-sm text-slate-500">No active channel viewers in the last minute.</p>
        ) : (
          <ul className="channel-list dashboard-mwc-list">
            {sorted.map((row) => (
              <li key={row.id} className="channel-item dashboard-mwc-row min-h-0">
                <span className="dashboard-mwc-channel-name min-w-0 flex-1 truncate">
                  {row.name}
                </span>
                <span className="watcher-badge dashboard-mwc-watchers-pill shrink-0 tabular-nums">
                  {row.watchers.toLocaleString()} live sessions
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

export default MostWatchedChannelsListCard
