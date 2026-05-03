import { useMemo } from 'react'
import { MapPin } from 'lucide-react'

/** Regional-indicator pair → flag emoji (ISO 3166-1 alpha-2). */
function flagEmoji(countryCode) {
  const code = (countryCode || '').toUpperCase()
  if (code.length !== 2) return '🌐'
  const A = 0x1f1e6
  const chars = [...code].map((c) => A + (c.charCodeAt(0) - 65))
  try {
    return String.fromCodePoint(...chars)
  } catch {
    return '🌐'
  }
}

function aggregateOnlineByCountry(users) {
  const map = new Map()
  for (const u of users) {
    if (u.status !== 'online') continue
    const key = u.countryCode
    const existing = map.get(key)
    if (existing) {
      existing.count += 1
    } else {
      map.set(key, {
        countryCode: key,
        countryName: u.countryName,
        count: 1,
      })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

/**
 * Same footprint as other `.dashboard-card` tiles — header fixed, list scrolls inside.
 */
function LiveUserLocationsCard({ users, className = 'dashboard-card' }) {
  const rows = useMemo(() => aggregateOnlineByCountry(users), [users])

  return (
    <article
      className={`border border-slate-600/35 shadow-[0_12px_28px_rgba(0,0,0,0.22)] ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0f172a 0%, #020617 100%)',
      }}
    >
      <div className="card-header flex items-center gap-2 border-b border-slate-700/60 pb-3">
        <MapPin className="h-5 w-5 shrink-0 text-white" aria-hidden />
        <h2 className="text-base font-bold tracking-tight text-[#FFFFFF]">Live User Locations</h2>
      </div>

      <div className="card-content">
        <ul className="live-locations-list">
          {rows.map((row) => (
            <li key={row.countryCode} className="live-location-row">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span
                  className="inline-flex shrink-0 items-center justify-center leading-none"
                  style={{ fontSize: '18px' }}
                  aria-hidden
                >
                  {flagEmoji(row.countryCode)}
                </span>
                <span className="truncate text-[15px] font-semibold text-[#FFFFFF]">
                  {row.countryName}
                </span>
              </span>
              <span className="shrink-0 text-[14px] font-medium tabular-nums text-[#BFC7D5]">
                {row.count} users
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}

export default LiveUserLocationsCard
