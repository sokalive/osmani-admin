/** Human-readable Live User Location labels — store + GET normalization. */

export const UNKNOWN_LOCATION = 'Unknown Location'

/** ISO 3166-1 alpha-2 → readable country fallback when city absent */
const COUNTRY_NAME = Object.freeze({
  TZ: 'Tanzania',
  KE: 'Kenya',
  UG: 'Uganda',
  RW: 'Rwanda',
  BI: 'Burundi',
  MW: 'Malawi',
  ZA: 'South Africa',
  US: 'United States',
  GB: 'United Kingdom',
})

function tidy(s) {
  return String(s ?? '')
    .replace(/[_/+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function ispOrProviderLike(s) {
  if (!s || s.length < 4) return false
  const u = s.toLowerCase()
  return (
    /\b(asn\s*\d+|vodacom|airtel|safaricom|tigo|hallo|halo|mikrotik|hosting|telecom|cable)\b/u.test(u) ||
    /\b(isp|internet|fib(er|re)|broadband|wireless)\b/u.test(u) ||
    /\b(ltd|limited|plc|inc\b|corp)\b/u.test(u) ||
    /[._](net|co|org|go|edu)\.[a-z]{2}\b/u.test(u) ||
    /\d{4,}/.test(s)
  )
}

function titlePlace(s) {
  const small = new Set(['and', 'or', 'of', 'the', 'in', 'on', 'at', 'es', 'la', 'el', 'de', 'von', 'das'])
  const t = tidy(s)
  if (!t) return ''
  const parts = t.split(/\s+/)
  return parts
    .map((w, i) => {
      const lw = w.toLowerCase()
      if (small.has(lw) && i > 0) return lw
      if (/\d/.test(w)) return w.toUpperCase() === w && w.length <= 5 ? w : w
      if (w.length <= 4 && /^[A-Z]+$/u.test(w)) return w
      return w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase()
    })
    .join(' ')
}

function countryFallbackLabel(code) {
  const c = String(code || '').slice(0, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  const name = COUNTRY_NAME[c]
  return name ? `${c} • ${name}` : ''
}

/** Prefer `TZ • Dar es Salaam`; accept legacy delimiters `|`, `-`. */
export function coerceCompositeLabel(legacyRaw) {
  const rawIn = tidy(String(legacyRaw ?? '').replace(/\s*[|−\-]\s*/g, ' • '))
  if (!rawIn) return ''
  const m = /^([A-Za-z]{2})\s*[•·]\s*(.+)$/u.exec(rawIn)
  if (m) {
    const c = m[1].toUpperCase()
    const fb = countryFallbackLabel(c)
    const restRaw = tidy(m[2])
    if (!restRaw || ispOrProviderLike(restRaw)) return fb || UNKNOWN_LOCATION
    if (/^unknown$/i.test(restRaw)) return fb || UNKNOWN_LOCATION
    return `${c} • ${titlePlace(restRaw)}`
  }
  if (/^[A-Za-z]{2}$/u.test(rawIn)) return countryFallbackLabel(rawIn)
  const leadIso = /^([A-Za-z]{2})\b/.exec(rawIn)
  if (ispOrProviderLike(rawIn)) {
    if (leadIso) {
      const fb = countryFallbackLabel(leadIso[1])
      if (fb) return fb
    }
    return UNKNOWN_LOCATION
  }
  return ''
}

/** Build normalized label from heartbeat / presence body fields. */
export function normalizeLocationPayload(body = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const ccRaw = tidy(b.country_code ?? b.countryCode ?? b.country_iso ?? '')
  let cc =
    /^[a-z]{2}$/iu.test(ccRaw.slice(0, 2))
      ? ccRaw.slice(0, 2).toUpperCase()
      : ''

  const placeSources = [
    b.city,
    b.region,
    b.locality,
    b.cityName,
    b.adminArea,
    b.geo_city,
    b.geoCity,
    b.place,
    b.placeName,
  ].map(tidy)
  let place = placeSources.find((p) => p && !ispOrProviderLike(p)) || ''

  const legacyCountry = tidy(b.country ?? '')
  /** Body already formatted */
  const composite = coerceCompositeLabel(legacyCountry)

  let out = ''

  if (cc && /^[A-Z]{2}$/.test(cc)) {
    if (place && !ispOrProviderLike(place)) {
      out = `${cc} • ${titlePlace(place)}`
    } else if (composite && composite !== UNKNOWN_LOCATION) {
      out = composite
    } else {
      out = countryFallbackLabel(cc) || UNKNOWN_LOCATION
    }
  } else if (composite) {
    out = composite
  } else if (legacyCountry) {
    if (ispOrProviderLike(legacyCountry)) out = UNKNOWN_LOCATION
    else {
      /** free-text city/country fallback */
      const c2 = coerceCompositeLabel(legacyCountry)
      out = c2 || UNKNOWN_LOCATION
    }
  } else if (place && !ispOrProviderLike(place)) {
    /** city only — no ISO */
    out = UNKNOWN_LOCATION
  }

  const maxLen = 120
  return out.slice(0, maxLen).trimEnd() || null
}

/** Sanitize persisted value for `/analytics/locations` responses. */
export function sanitizeStoredLocationDisplay(raw) {
  const sIn = tidy(raw)
  if (!sIn) return UNKNOWN_LOCATION
  if (!ispOrProviderLike(sIn)) {
    const c = coerceCompositeLabel(sIn)
    if (c && c !== UNKNOWN_LOCATION) return c
  }
  const leadIso = /^([A-Za-z]{2})\b/.exec(sIn)
  if (leadIso) {
    const fb = countryFallbackLabel(leadIso[1])
    if (fb) return fb
  }
  const c2 = coerceCompositeLabel(sIn)
  if (c2 && c2 !== UNKNOWN_LOCATION) return c2
  return UNKNOWN_LOCATION
}

/** Merge COUNT buckets that share the same full normalized CC • place label. */
export function mergeLocationBucketsByNormalizedLabel(rows) {
  const acc = new Map()
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const raw = row.country ?? row.country_code ?? ''
    const usersRaw = Number(row.users ?? row.user_count ?? 0)
    const users = Number.isFinite(usersRaw) ? Math.floor(Math.max(0, usersRaw)) : 0
    if (!users) continue
    const label = sanitizeStoredLocationDisplay(raw)
    if (!label) continue
    acc.set(label, (acc.get(label) || 0) + users)
  }
  return [...acc.entries()]
    .map(([country, users]) => ({ country, users }))
    .sort((a, b) => b.users - a.users || String(a.country).localeCompare(String(b.country)))
}
