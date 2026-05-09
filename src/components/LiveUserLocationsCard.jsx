import { useMemo } from 'react'
import { MapPin } from 'lucide-react'

function isoFromLocationLabel(display) {
  const s = String(display || '').trim()
  if (!s) return '__'
  const m = /^([A-Z]{2})\s*[•·]\s*/u.exec(s)
  if (m) return m[1]
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase()
  return '__'
}

/** Regional-indicator pair → flag emoji (ISO 3166-1 alpha-2). */
function flagEmoji(countryCode) {
  const code = (countryCode || '').toUpperCase()
  if (code === '__' || code.length !== 2 || !/^[A-Z]{2}$/.test(code)) return '🌐'
  const A = 0x1f1e6
  const chars = [...code].map((c) => A + (c.charCodeAt(0) - 65))
  try {
    return String.fromCodePoint(...chars)
  } catch {
    return '🌐'
  }
}

/**
 * Same footprint as other `.dashboard-card` tiles — header fixed, list scrolls inside.
 * Each API bucket = one vertical row (`country`, `users` count).
 */
function LiveUserLocationsCard({ locations, className = 'dashboard-card' }) {
  const rows = useMemo(() => {
    const list = Array.isArray(locations) ? locations : []
    const mapped = list
      .map((row) => {
        const locationLabel = String(row?.country ?? '').trim() || 'Unknown Location'
        const count = Math.max(0, Math.floor(Number(row?.users) || 0))
        return {
          locationLabel,
          countryCode: isoFromLocationLabel(locationLabel),
          count,
        }
      })
      .filter((r) => r.count > 0 && r.locationLabel)
    mapped.sort((a, b) => b.count - a.count || a.locationLabel.localeCompare(b.locationLabel))
    return mapped
  }, [locations])

  return (
    <article
      className={`border border-slate-600/35 shadow-[0_12px_28px_rgba(0,0,0,0.22)] ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0f172a 0%, #020617 100%)',
      }}
    >
      <div className="card-header flex shrink-0 items-center gap-2 border-b border-slate-700/60 pb-3">
        <MapPin className="h-5 w-5 shrink-0 text-white" aria-hidden />
        <h2 className="text-base font-bold tracking-tight text-[#FFFFFF]">Live User Locations</h2>
      </div>

      <div className="card-content live-user-locations-scroll flex min-h-0 w-full flex-1 overflow-y-scroll">
        <ul className="live-locations-list w-full shrink-0">
          {rows.map((row) => (
            <li key={row.locationLabel} className="live-location-row">
              <span className="flex min-w-0 flex-1 items-start gap-2.5 py-0.5">
                <span
                  className="mt-0.5 inline-flex shrink-0 items-center justify-center leading-none"
                  style={{ fontSize: '18px' }}
                  aria-hidden
                >
                  {flagEmoji(row.countryCode)}
                </span>
                <span className="break-words text-left text-[15px] font-semibold leading-snug text-[#FFFFFF]">
                  {row.locationLabel}
                </span>
              </span>
              <span className="mt-0.5 shrink-0 self-start text-[14px] font-medium tabular-nums text-[#BFC7D5]">
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
