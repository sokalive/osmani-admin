/**
 * Short-lived in-process cache for subscription access reads on hot verify paths.
 */
const DEFAULT_TTL_MS = Math.max(
  500,
  Math.min(15_000, Number(process.env.SUBSCRIPTION_ACCESS_CACHE_MS) || 3000),
)
const ACTIVE_TTL_MS = Math.max(
  DEFAULT_TTL_MS,
  Math.min(60_000, Number(process.env.SUBSCRIPTION_ACCESS_CACHE_ACTIVE_MS) || 8000),
)

function ttlForRow(row) {
  if (row?.active_now === true && row?.blocked_now !== true) return ACTIVE_TTL_MS
  return DEFAULT_TTL_MS
}

/** @type {Map<string, { expiresAt: number, row: object|null }>} */
const cache = new Map()

function cacheKey(deviceId, fingerprint) {
  const fp = String(fingerprint ?? '').trim()
  return `${String(deviceId ?? '').trim()}|${fp}`
}

function sanitizeAccessCacheRow(row) {
  if (!row) return row
  const status = String(row.status ?? '').toLowerCase()
  if (status !== 'active' || row.blocked_now === true || row.admin_revoked_at) {
    return {
      ...row,
      active_now: false,
      remaining_seconds: 0,
      remaining_hours: 0,
      remaining_days: 0,
      near_expiry: false,
    }
  }
  if (row.active_now === true && row.blocked_now !== true) return row
  const rem = Number(row.remaining_seconds ?? 0)
  if (Number.isFinite(rem) && rem > 0 && status === 'active') return row
  return row
}

export function getCachedSubscriptionAccess(deviceId, fingerprint) {
  const key = cacheKey(deviceId, fingerprint)
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return sanitizeAccessCacheRow(hit.row)
}

/** Returns last cached row even if TTL expired — for stale-active fallback only. */
export function getStaleCachedSubscriptionAccess(deviceId, fingerprint) {
  const hit = cache.get(cacheKey(deviceId, fingerprint))
  return sanitizeAccessCacheRow(hit?.row)
}

export function setCachedSubscriptionAccess(deviceId, fingerprint, row, ttlMs) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  const ttl = ttlMs != null ? ttlMs : ttlForRow(row)
  cache.set(cacheKey(deviceId, fingerprint), {
    row: row ?? null,
    expiresAt: Date.now() + ttl,
  })
}

export function invalidateSubscriptionAccessCache(deviceId) {
  const prefix = `${String(deviceId ?? '').trim()}|`
  if (!prefix || prefix === '|') return
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}
