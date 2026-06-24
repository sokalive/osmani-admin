/** Human-readable Live User Location labels — store + GET normalization. */

import { extractClientIp, lookupIpGeo } from './ipGeoLookup.js'

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
  FR: 'France',
  DE: 'Germany',
  CN: 'China',
  IN: 'India',
})

/** Reverse lookup: "tanzania" → TZ (for clients that send country name without ISO). */
function countryNameToIsoCode(name) {
  const n = tidy(name).toLowerCase()
  if (!n) return ''
  for (const [code, label] of Object.entries(COUNTRY_NAME)) {
    if (label.toLowerCase() === n) return code
  }
  return ''
}

/**
 * Fill missing ISO / place from reverse-proxy geo headers (no external API).
 * Node lowercases header names; values are untrusted — run through same tidy/ISP filters as body.
 */
export function enrichLocationBodyFromRequest(body, req) {
  const b = body && typeof body === 'object' ? { ...body } : {}
  if (!req?.headers || typeof req.headers !== 'object') return b
  const h = req.headers

  const hdr = (name) => tidy(h[name] ?? '')

  const hdrCc = hdr('cf-ipcountry') || hdr('x-vercel-ip-country') || hdr('x-country-code')
  const hdrCity =
    hdr('cf-ipcity') ||
    hdr('x-vercel-ip-city') ||
    hdr('fastly-client-geo-city') ||
    hdr('x-geo-city') ||
    hdr('x-app-geo-city')
  const hdrRegion =
    hdr('cf-region') ||
    hdr('x-vercel-ip-country-region') ||
    hdr('fastly-client-geo-region') ||
    hdr('x-geo-region') ||
    hdr('x-app-geo-region')

  const hasCc = () => hasCountryCodeInBody(b)
  const hasPlace = () => hasResolvedPlaceInBody(b)

  if (!hasCc() && /^[a-z]{2}$/iu.test(hdrCc.slice(0, 2))) {
    b.country_code = hdrCc.slice(0, 2).toUpperCase()
  }
  if (!hasPlace()) {
    if (hdrCity && !ispOrProviderLike(hdrCity)) {
      b.city = hdrCity
    } else if (hdrRegion && !ispOrProviderLike(hdrRegion)) {
      b.region = hdrRegion
    }
  }
  return b
}

/**
 * IP geolocation fallback after client body + proxy headers (city → region → country).
 * @param {Record<string, unknown>} body
 * @param {import('express').Request | null | undefined} req
 */
export async function enrichLocationBodyFromIp(body, req) {
  let b = enrichLocationBodyFromRequest(body && typeof body === 'object' ? body : {}, req)
  const needsCc = !hasCountryCodeInBody(b)
  const needsCity = !hasCityInBody(b)
  const needsRegion = !hasRegionInBody(b)
  if (!needsCc && !needsCity && !needsRegion) return b

  const geo = await lookupIpGeo(extractClientIp(req))
  if (!geo.ok) return b

  if (needsCc && geo.countryCode) b.country_code = geo.countryCode
  if (needsCity && geo.city) b.city = geo.city
  else if (needsRegion && geo.region) b.region = geo.region
  return b
}

/** Sum users across place rows (matches live_sessions row count when grouped). */
export function sumLocationsOnline(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.reduce((sum, row) => sum + (Number(row?.users) || 0), 0)
}

function tidy(s) {
  return String(s ?? '')
    .replace(/[_/+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CITY_BODY_KEYS = [
  'city',
  'locality',
  'cityName',
  'geo_city',
  'geoCity',
  'place',
  'placeName',
  'localityName',
  'locality_name',
]

const REGION_BODY_KEYS = [
  'region',
  'adminArea',
  'regionName',
  'region_name',
  'admin_area',
  'adminAreaLevel1',
  'admin_area_level_1',
  'state',
  'province',
  'division',
  'subdivision',
]

function pickBodyField(b, keys) {
  const body = b && typeof b === 'object' ? b : {}
  for (const key of keys) {
    const value = tidy(body[key])
    if (value && !ispOrProviderLike(value)) return value
  }
  return ''
}

function hasCountryCodeInBody(b) {
  const raw = tidy(b?.country_code ?? b?.countryCode ?? b?.country_iso ?? '')
  return /^[a-z]{2}$/iu.test(raw.slice(0, 2))
}

function hasCityInBody(b) {
  return Boolean(pickBodyField(b, CITY_BODY_KEYS))
}

function hasRegionInBody(b) {
  return Boolean(pickBodyField(b, REGION_BODY_KEYS))
}

function hasResolvedPlaceInBody(b) {
  return hasCityInBody(b) || hasRegionInBody(b)
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
export function normalizeLocationPayload(body = {}, req = null) {
  const merged = enrichLocationBodyFromRequest(body && typeof body === 'object' ? body : {}, req)
  const b = merged
  let ccRaw = tidy(b.country_code ?? b.countryCode ?? b.country_iso ?? '')
  let cc =
    /^[a-z]{2}$/iu.test(ccRaw.slice(0, 2))
      ? ccRaw.slice(0, 2).toUpperCase()
      : ''

  let place = pickBodyField(b, CITY_BODY_KEYS) || pickBodyField(b, REGION_BODY_KEYS)

  const legacyCountry = tidy(b.country ?? '')
  /** Body already formatted */
  const composite = coerceCompositeLabel(legacyCountry)

  let out = ''

  if (!cc && legacyCountry && !composite) {
    const fromName = countryNameToIsoCode(legacyCountry)
    if (fromName) cc = fromName
  }

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
      let c2 = coerceCompositeLabel(legacyCountry)
      if (!c2 || c2 === UNKNOWN_LOCATION) {
        const isoGuess = countryNameToIsoCode(legacyCountry)
        if (isoGuess) c2 = countryFallbackLabel(isoGuess) || UNKNOWN_LOCATION
      }
      out = c2 || UNKNOWN_LOCATION
    }
  } else if (place && !ispOrProviderLike(place)) {
    /** city only — no ISO */
    out = UNKNOWN_LOCATION
  }

  const maxLen = 120
  return out.slice(0, maxLen).trimEnd() || null
}

/** Client body → proxy headers → IP geo → normalized `CC • place` label. */
export async function resolveLocationLabel(body = {}, req = null) {
  const enriched = await enrichLocationBodyFromIp(body, req)
  return normalizeLocationPayload(enriched, req)
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

/** Extract ISO 3166-1 alpha-2 from stored `live_sessions.country` labels. */
export function parseCountryCodeFromStoredLabel(raw) {
  const s = tidy(String(raw ?? ''))
  if (!s || /^unknown\b/i.test(s)) return ''
  const bullet = /^([A-Za-z]{2})\s*[•·]\s*(.+)$/u.exec(s)
  if (bullet) return bullet[1].toUpperCase()
  const isoOnly = /^([A-Za-z]{2})$/u.exec(s)
  if (isoOnly) return isoOnly[1].toUpperCase()
  const lead = /^([A-Za-z]{2})\b/u.exec(s)
  if (lead) return lead[1].toUpperCase()
  return countryNameToIsoCode(s) || ''
}

/** Readable country name for ISO code (falls back to code). */
export function countryNameForCode(code) {
  const c = String(code || '').slice(0, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return UNKNOWN_LOCATION
  return COUNTRY_NAME[c] || c
}

/** Place label after ISO code from stored `CC • place` (city/region/country fallback). */
export function parsePlaceFromStoredLabel(raw) {
  const s = tidy(String(raw ?? ''))
  if (!s || /^unknown\b/i.test(s)) return ''
  const bullet = /^([A-Za-z]{2})\s*[•·]\s*(.+)$/u.exec(s)
  if (bullet) {
    const place = titlePlace(bullet[2])
    if (!place || ispOrProviderLike(place)) return ''
    return place
  }
  if (ispOrProviderLike(s)) return ''
  const c = coerceCompositeLabel(s)
  if (c && c !== UNKNOWN_LOCATION) {
    const m = /^([A-Z]{2})\s*[•·]\s*(.+)$/u.exec(c)
    if (m) return titlePlace(m[2])
  }
  return titlePlace(s)
}

/** True when stored place is only the country name (no city/region resolved). */
export function isCountryNameOnlyPlace(countryCode, placeName) {
  const code = String(countryCode || '').slice(0, 2).toUpperCase()
  const place = String(placeName || '').trim()
  if (!code || !place) return false
  const countryName = countryNameForCode(code)
  if (countryName === UNKNOWN_LOCATION) return false
  return place.toLowerCase() === countryName.toLowerCase()
}

/**
 * Dashboard rows grouped by country + city/region (not rolled up to country only).
 * Returns `{ countryCode, placeName, users, country, location }` sorted by users desc.
 * `country` / `location` are `CC — Place` or `Unknown Location` for legacy consumers.
 */
export function aggregateLocationsByPlace(rows) {
  const cityMerged = mergeLocationBucketsByNormalizedLabel(rows)
  const acc = new Map()
  for (const { country: rawLabel, users } of cityMerged) {
    const label = sanitizeStoredLocationDisplay(rawLabel)
    const code = parseCountryCodeFromStoredLabel(label)
    let placeName = parsePlaceFromStoredLabel(label)
    if (!placeName && code) {
      const countryOnly = countryNameForCode(code)
      placeName = countryOnly !== UNKNOWN_LOCATION ? countryOnly : ''
    }
    if (isCountryNameOnlyPlace(code, placeName)) {
      placeName = UNKNOWN_LOCATION
    }
    if (!placeName) placeName = UNKNOWN_LOCATION
    const countryCode = placeName === UNKNOWN_LOCATION ? '' : code
    const key = countryCode ? `${countryCode}|${placeName}` : UNKNOWN_LOCATION
    const prev = acc.get(key) || { countryCode, placeName, users: 0 }
    prev.users += users
    acc.set(key, prev)
  }
  return [...acc.values()]
    .map(({ countryCode, placeName, users }) => {
      const location =
        countryCode && placeName !== UNKNOWN_LOCATION
          ? `${countryCode} — ${placeName}`
          : placeName
      return {
        countryCode,
        placeName,
        users,
        country: location,
        location,
      }
    })
    .sort((a, b) => b.users - a.users || String(a.location).localeCompare(String(b.location)))
}

/**
 * Roll city/region rows up to country for dashboard widgets.
 * Returns `{ countryCode, countryName, users, country }` sorted by users desc.
 * `country` is `CC — Name` for backward-compatible consumers.
 */
export function aggregateLocationsByCountryCode(rows) {
  const cityMerged = mergeLocationBucketsByNormalizedLabel(rows)
  const acc = new Map()
  for (const { country, users } of cityMerged) {
    const code = parseCountryCodeFromStoredLabel(country)
    const key = code || '__UNKNOWN__'
    acc.set(key, (acc.get(key) || 0) + users)
  }
  return [...acc.entries()]
    .map(([key, users]) => {
      const countryCode = key === '__UNKNOWN__' ? '' : key
      const countryName = countryNameForCode(countryCode)
      const country = countryCode ? `${countryCode} — ${countryName}` : countryName
      return { countryCode, countryName, users, country }
    })
    .sort((a, b) => b.users - a.users || String(a.countryName).localeCompare(String(b.countryName)))
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
