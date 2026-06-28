import { useMemo } from 'react'
import { MapPin } from 'lucide-react'
import { aggregateLocationsByPlace } from '../../server/src/lib/analyticsLocation.js'

/** Regional-indicator pair → flag emoji (ISO 3166-1 alpha-2). */
export function flagEmoji(countryCode) {
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

export function userCountLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0))
  if (count <= 0) return ''
  if (count === 1) return '1 User'
  return `${count} Users`
}

/** Accept API place rows or raw SQL buckets; never roll up to country-only. */
export function normalizePlaceRows(locations) {
  const list = Array.isArray(locations) ? locations : []
  if (
    list.length > 0 &&
    list.every((row) => row && (row.placeName != null || row.location != null))
  ) {
    return list
      .filter((row) => Number(row.users) > 0)
      .map((row) => ({
        countryCode: row.countryCode || '',
        placeName: row.placeName || row.location || 'Unknown Location',
        users: Number(row.users) || 0,
        location: row.location || row.country || row.placeName || 'Unknown Location',
      }))
  }
  return aggregateLocationsByPlace(
    list.map((row) => ({
      country: row.country ?? row.location ?? row.placeName ?? '',
      users: row.users,
    })),
  ).filter((row) => row.users > 0)
}

export function LiveLocationRowList({ rows, scroll = true, className = '' }) {
  if (!rows.length) {
    return <p className="py-2 text-sm text-slate-500">No active location data yet.</p>
  }
  return (
    <ul
      className={`live-locations-list ${scroll ? 'live-locations-list--scroll' : ''} ${className}`.trim()}
    >
      {rows.map((row) => {
        const isUnknown = !row.countryCode || row.placeName === 'Unknown Location'
        const code = row.countryCode || ''
        const place = row.placeName || 'Unknown Location'
        const rowKey = row.location || `${code}|${place}|${row.users}`
        return (
          <li key={rowKey} className="live-location-row">
            <span className="live-location-primary">
              <span
                className="inline-flex shrink-0 items-center justify-center leading-none"
                style={{ fontSize: '18px' }}
                aria-hidden
              >
                {flagEmoji(row.countryCode)}
              </span>
              {!isUnknown ? (
                <>
                  <span className="live-location-code">{code}</span>
                  <span className="live-location-sep" aria-hidden>
                    —
                  </span>
                </>
              ) : null}
              <span className="live-location-name">{place}</span>
            </span>
            <span className="live-location-count">{userCountLabel(row.users)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Same footprint as other `.dashboard-card` tiles — header fixed, list scrolls inside.
 */
function LiveUserLocationsCard({
  locations,
  totalOnline = 0,
  watchingNow = 0,
  idleNow = 0,
  className = 'dashboard-card',
}) {
  const rows = useMemo(() => normalizePlaceRows(locations), [locations])
  const rowTotal = useMemo(
    () => rows.reduce((sum, row) => sum + (Number(row.users) || 0), 0),
    [rows],
  )
  const total = rowTotal > 0 ? rowTotal : Math.max(0, Math.floor(Number(totalOnline) || 0))
  const watching = Math.max(0, Math.floor(Number(watchingNow) || 0))
  const idle = Math.max(0, Math.floor(Number(idleNow) || 0))

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
        <p className="live-locations-total mb-3 text-sm font-semibold text-slate-300">
          Total Online Users:{' '}
          <span className="font-bold tabular-nums text-white">{total.toLocaleString('en-US')}</span>
          {watching > 0 || idle > 0 ? (
            <span className="mt-1 block text-xs font-medium text-slate-400">
              <span className="tabular-nums text-emerald-300">{watching.toLocaleString('en-US')}</span>{' '}
              watching
              {idle > 0 ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="tabular-nums text-amber-200/90">{idle.toLocaleString('en-US')}</span>{' '}
                  idle (app open)
                </>
              ) : null}
            </span>
          ) : null}
        </p>
        <LiveLocationRowList rows={rows} />
      </div>
    </article>
  )
}

export default LiveUserLocationsCard
