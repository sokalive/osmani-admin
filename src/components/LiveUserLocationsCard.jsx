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

const UNKNOWN = 'Unknown Location'

/**
 * API rows use `{ country, users }` where `country` is a normalized label such as `TZ • Dar es Salaam`.
 */
function parseCountryPlaceLine(rawLabel) {
  const raw = String(rawLabel ?? '').trim() || UNKNOWN
  const bullet = /^([A-Za-z]{2})\s*[•·]\s*(.+)$/u.exec(raw)
  if (bullet) {
    const countryCode = bullet[1].toUpperCase()
    const place = bullet[2].trim() || UNKNOWN
    return {
      countryCode,
      displayLine: `${countryCode} • ${place}`,
    }
  }
  const isoOnly = /^([A-Za-z]{2})$/u.exec(raw)
  if (isoOnly) {
    const countryCode = isoOnly[1].toUpperCase()
    return {
      countryCode,
      displayLine: `${countryCode} • ${UNKNOWN}`,
    }
  }
  const leadIso = /^([A-Za-z]{2})\b/u.exec(raw)
  if (leadIso) {
    const countryCode = leadIso[1].toUpperCase()
    const rest = raw.slice(2).replace(/^\s*[•·\-|]\s*/u, '').trim()
    const place = rest && rest !== countryCode ? rest : UNKNOWN
    return {
      countryCode,
      displayLine: `${countryCode} • ${place}`,
    }
  }
  return {
    countryCode: '',
    displayLine: raw,
  }
}

function userCountLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0))
  if (count <= 0) return ''
  if (count === 1) return '1 user'
  return `${count} users`
}

function normalizeLocationRows(locations) {
  if (!Array.isArray(locations)) return []
  return locations
    .map((row) => {
      const raw = String(row?.country ?? '').trim() || UNKNOWN
      const count = Math.max(0, Math.floor(Number(row?.users) || 0))
      const { countryCode, displayLine } = parseCountryPlaceLine(raw)
      return {
        /** Full bucket label from API — unique per region/city row (not only ISO). */
        key: raw,
        countryCode,
        displayLine,
        count,
      }
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || String(a.displayLine).localeCompare(String(b.displayLine)))
}

/**
 * Same footprint as other `.dashboard-card` tiles — header fixed, list scrolls inside.
 */
function LiveUserLocationsCard({ locations, className = 'dashboard-card' }) {
  const rows = useMemo(() => normalizeLocationRows(locations), [locations])

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
            <li key={row.key} className="live-location-row">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span
                  className="inline-flex shrink-0 items-center justify-center leading-none"
                  style={{ fontSize: '18px' }}
                  aria-hidden
                >
                  {flagEmoji(row.countryCode)}
                </span>
                <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-[#FFFFFF]">
                  {row.displayLine}
                </span>
              </span>
              <span className="shrink-0 text-[14px] font-medium tabular-nums text-[#BFC7D5]">
                {userCountLabel(row.count)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}

export default LiveUserLocationsCard
