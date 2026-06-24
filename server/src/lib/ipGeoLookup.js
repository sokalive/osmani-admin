/** Best-effort IP geolocation for analytics presence (cached, no API key). */

const CACHE = new Map()
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const LOOKUP_TIMEOUT_MS = 1200

function tidy(s) {
  return String(s ?? '').trim()
}

export function extractClientIp(req) {
  const raw = tidy(
    req?.headers?.['cf-connecting-ip'] ??
      req?.headers?.['x-real-ip'] ??
      req?.headers?.['x-forwarded-for'] ??
      req?.socket?.remoteAddress ??
      '',
  )
  if (!raw) return ''
  return raw.split(',')[0].trim()
}

function isPrivateOrLocalIp(ip) {
  const s = tidy(ip).toLowerCase()
  if (!s || s === 'unknown') return true
  if (s === '::1' || s === '127.0.0.1') return true
  if (s.startsWith('10.')) return true
  if (s.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(s)) return true
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true
  return false
}

function cacheGet(ip) {
  const hit = CACHE.get(ip)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    CACHE.delete(ip)
    return null
  }
  return hit.value
}

function cacheSet(ip, value) {
  CACHE.set(ip, { at: Date.now(), value })
  if (CACHE.size > 5000) {
    const oldest = CACHE.keys().next().value
    if (oldest) CACHE.delete(oldest)
  }
}

/**
 * @param {string} ip
 * @returns {Promise<{ ok: true, countryCode: string, city: string, region: string } | { ok: false }>}
 */
export async function lookupIpGeo(ip) {
  const normalized = tidy(ip)
  if (!normalized || isPrivateOrLocalIp(normalized)) return { ok: false }

  const cached = cacheGet(normalized)
  if (cached) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(normalized)}?fields=status,countryCode,city,regionName`
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      cacheSet(normalized, { ok: false })
      return { ok: false }
    }
    const body = await res.json().catch(() => ({}))
    if (body?.status !== 'success') {
      cacheSet(normalized, { ok: false })
      return { ok: false }
    }
    const countryCode = tidy(body.countryCode).slice(0, 2).toUpperCase()
    const city = tidy(body.city)
    const region = tidy(body.regionName)
    const value = {
      ok: true,
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : '',
      city,
      region,
    }
    cacheSet(normalized, value)
    return value
  } catch {
    cacheSet(normalized, { ok: false })
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}
