/**
 * Short-lived in-process cache for subscription access reads on hot verify paths.
 *
 * HARDENING RULES (permanent):
 * - Cache is NEVER the source of truth. Backend/DB is the only SoT.
 * - Stale (TTL-expired) entries must NOT restore subscription state.
 * - Every entry is versioned; version bump invalidates the whole map.
 * - Writers must invalidate on DELETE USER / payment / activation / revocation / migration / plan update.
 */
import { SUBSCRIPTION_ACCESS_CACHE_VERSION } from './subscriptionHardeningConstants.js'

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

/** @type {Map<string, { expiresAt: number, version: string, row: object|null }>} */
const cache = new Map()

function cacheKey(deviceId, fingerprint) {
  const fp = String(fingerprint ?? '').trim()
  return `${SUBSCRIPTION_ACCESS_CACHE_VERSION}|${String(deviceId ?? '').trim()}|${fp}`
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

/**
 * Canonical verification of a cache row before serving.
 * If the row claims active while revoked/expired markers exist → treat as miss.
 */
function verifyCanonicalCacheRow(row) {
  if (row == null) return row
  const status = String(row.status ?? '').toLowerCase()
  if (status === 'revoked' || row.admin_revoked_at) {
    return sanitizeAccessCacheRow({ ...row, active_now: false })
  }
  if (row.active_now === true) {
    const exp = row.expires_at ?? row.expiresAt
    if (exp != null) {
      const ms = new Date(exp).getTime()
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        return undefined // force DB refresh — never serve stale-active
      }
    }
  }
  return sanitizeAccessCacheRow(row)
}

export function getCachedSubscriptionAccess(deviceId, fingerprint) {
  const key = cacheKey(deviceId, fingerprint)
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.version !== SUBSCRIPTION_ACCESS_CACHE_VERSION) {
    cache.delete(key)
    return undefined
  }
  if (Date.now() > hit.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return verifyCanonicalCacheRow(hit.row)
}

/**
 * @deprecated Stale cache must NEVER restore subscription state.
 * Always returns undefined so callers refresh from the production database.
 */
export function getStaleCachedSubscriptionAccess(_deviceId, _fingerprint) {
  return undefined
}

export function setCachedSubscriptionAccess(deviceId, fingerprint, row, ttlMs) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  const verified = verifyCanonicalCacheRow(row)
  if (verified === undefined) return
  const ttl = ttlMs != null ? ttlMs : ttlForRow(verified)
  cache.set(cacheKey(deviceId, fingerprint), {
    row: verified ?? null,
    version: SUBSCRIPTION_ACCESS_CACHE_VERSION,
    expiresAt: Date.now() + ttl,
  })
}

export function invalidateSubscriptionAccessCache(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  const needle = `|${d}|`
  for (const key of cache.keys()) {
    if (key.includes(needle) || key.endsWith(`|${d}|`) || key.includes(`|${d}|`)) {
      cache.delete(key)
    }
  }
  // Also clear any pre-version keys that used old format `${deviceId}|${fp}`
  const legacyPrefix = `${d}|`
  for (const key of cache.keys()) {
    if (key.startsWith(legacyPrefix)) cache.delete(key)
  }
}

/** Drop the entire in-process access cache (version bump / emergency). */
export function clearAllSubscriptionAccessCache() {
  cache.clear()
}

export function subscriptionAccessCacheStats() {
  return {
    size: cache.size,
    version: SUBSCRIPTION_ACCESS_CACHE_VERSION,
    ttl_default_ms: DEFAULT_TTL_MS,
    ttl_active_ms: ACTIVE_TTL_MS,
    stale_restore_disabled: true,
    source_of_truth: 'database',
  }
}
