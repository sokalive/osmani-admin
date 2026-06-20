/**
 * Short-lived in-process cache for subscription access reads on hot verify paths.
 */
const DEFAULT_TTL_MS = Math.max(
  500,
  Math.min(15_000, Number(process.env.SUBSCRIPTION_ACCESS_CACHE_MS) || 3000),
)

/** @type {Map<string, { expiresAt: number, row: object|null }>} */
const cache = new Map()

function cacheKey(deviceId, fingerprint) {
  const fp = String(fingerprint ?? '').trim()
  return `${String(deviceId ?? '').trim()}|${fp}`
}

export function getCachedSubscriptionAccess(deviceId, fingerprint) {
  const key = cacheKey(deviceId, fingerprint)
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return hit.row
}

export function setCachedSubscriptionAccess(deviceId, fingerprint, row, ttlMs = DEFAULT_TTL_MS) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  cache.set(cacheKey(deviceId, fingerprint), {
    row: row ?? null,
    expiresAt: Date.now() + ttlMs,
  })
}

export function invalidateSubscriptionAccessCache(deviceId) {
  const prefix = `${String(deviceId ?? '').trim()}|`
  if (!prefix || prefix === '|') return
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}
