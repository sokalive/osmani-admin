import { useMemo } from 'react'
import { MapPin } from 'lucide-react'
import { aggregateLocationsByCountryCode } from '../../server/src/lib/analyticsLocation.js'

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

function userCountLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0))
  if (count <= 0) return ''
  if (count === 1) return '1 User'
  return `${count} Users`
}

function normalizeAggregatedRows(locations) {
  const aggregated = aggregateLocationsByCountryCode(
    Array.isArray(locations) ? locations : [],
  )
  return aggregated.filter((row) => row.users > 0)
}

/**
 * Same footprint as other `.dashboard-card` tiles — header fixed, list scrolls inside.
 */
function LiveUserLocationsCard({ locations, className = 'dashboard-card' }) {
  const rows = useMemo(() => normalizeAggregatedRows(locations), [locations])

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
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No active location data yet.</p>
        ) : (
          <ul className="live-locations-list">
            {rows.map((row) => {
              const code = row.countryCode || '—'
              const name = row.countryName || 'Unknown Location'
              return (
                <li key={row.countryCode || row.countryName} className="live-location-row">
                  <span className="live-location-primary">
                    <span
                      className="inline-flex shrink-0 items-center justify-center leading-none"
                      style={{ fontSize: '18px' }}
                      aria-hidden
                    >
                      {flagEmoji(row.countryCode)}
                    </span>
                    <span className="live-location-code">{code}</span>
                    <span className="live-location-sep" aria-hidden>
                      —
                    </span>
                    <span className="live-location-name">{name}</span>
                  </span>
                  <span className="live-location-count">{userCountLabel(row.users)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </article>
  )
}

export default LiveUserLocationsCard
