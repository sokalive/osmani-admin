/**
 * In-memory JSON response cache for safe public GET catalog endpoints.
 * Not a second HTTP cache layer — complements CDN + client polling reduction.
 */

const DEFAULT_MAX_ENTRIES = Math.min(
  256,
  Math.max(8, Number(process.env.API_CACHE_MAX_ENTRIES) || 48),
)

/** @type {Map<string, { body: unknown, status: number, expiresAt: number }>} */
const store = new Map()

/** @type {Map<string, Promise<{ body: unknown, status: number }>>} */
const inflight = new Map()

const stats = {
  hit: 0,
  miss: 0,
  dedup: 0,
  store: 0,
  evict: 0,
  invalidate: 0,
}

function cacheEnabled() {
  const raw = String(process.env.API_CACHE_ENABLED ?? '1').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function devDiagnosticsEnabled() {
  if (String(process.env.API_CACHE_DEBUG || '').trim() === '1') return true
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
}

function stableOrigin(req) {
  const fromEnv = String(process.env.BASE_URL || '').trim().replace(/\/+$/, '')
  if (fromEnv) return fromEnv
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim()
  return host ? `${proto}://${host}`.replace(/\/+$/, '') : 'default'
}

export function buildApiCacheKey(namespace, req) {
  const url = String(req.originalUrl || req.url || '/')
  return `${namespace}|${stableOrigin(req)}|${url}`
}

function evictExpired() {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key)
      stats.evict += 1
    }
  }
}

function trimToMaxSize() {
  while (store.size > DEFAULT_MAX_ENTRIES) {
    const first = store.keys().next().value
    if (first == null) break
    store.delete(first)
    stats.evict += 1
  }
}

function remember(key, entry, ttlMs) {
  store.set(key, {
    body: entry.body,
    status: entry.status,
    expiresAt: Date.now() + ttlMs,
  })
  stats.store += 1
  evictExpired()
  trimToMaxSize()
}

function sendCached(res, entry, diag) {
  if (devDiagnosticsEnabled()) {
    res.setHeader('X-Api-Cache', diag)
  }
  res.status(entry.status)
  return res.json(entry.body)
}

/**
 * @param {string} namespace
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {number} ttlMs
 */
export function serveFromApiCacheOrContinue(namespace, req, res, next, ttlMs) {
  if (!cacheEnabled() || req.method !== 'GET') {
    return next()
  }

  const key = buildApiCacheKey(namespace, req)
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expiresAt > now) {
    stats.hit += 1
    return sendCached(res, hit, 'HIT')
  }

  const pending = inflight.get(key)
  if (pending) {
    stats.dedup += 1
    pending
      .then((entry) => sendCached(res, entry, 'DEDUP'))
      .catch((err) => next(err))
    return
  }

  stats.miss += 1

  let settled = false
  /** @type {(v: { body: unknown, status: number }) => void} */
  let settleInflight = () => {}
  /** @type {(e: Error) => void} */
  let rejectInflight = () => {}
  const inflightPromise = new Promise((resolve, reject) => {
    settleInflight = resolve
    rejectInflight = reject
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        inflight.delete(key)
        reject(new Error('API cache handler did not finish'))
      }
    }, Math.max(60_000, ttlMs * 4))
    timer.unref?.()
  })
  inflight.set(key, inflightPromise)

  const finishUncached = () => {
    if (settled) return
    settled = true
    inflight.delete(key)
    rejectInflight(new Error('Response not cached'))
  }
  if (typeof res.once === 'function') {
    res.once('finish', finishUncached)
    res.once('close', finishUncached)
  }

  const origJson = res.json.bind(res)
  res.json = function jsonWithCache(body) {
    if (typeof res.removeListener === 'function') {
      res.removeListener('finish', finishUncached)
      res.removeListener('close', finishUncached)
    }
    const status = res.statusCode || 200
    if (!settled && status >= 200 && status < 300) {
      const entry = { body, status }
      remember(key, entry, ttlMs)
      settled = true
      settleInflight(entry)
      inflight.delete(key)
    } else if (!settled) {
      settled = true
      inflight.delete(key)
      settleInflight({ body, status })
    }
    if (devDiagnosticsEnabled()) {
      res.setHeader('X-Api-Cache', 'MISS')
    }
    return origJson(body)
  }

  next()
}

export function invalidateApiCacheNamespace(namespace) {
  const prefix = `${namespace}|`
  let removed = 0
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key)
      removed += 1
    }
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      inflight.delete(key)
    }
  }
  if (removed > 0) stats.invalidate += removed
  return removed
}

export function invalidateAllApiCache() {
  const n = store.size
  store.clear()
  inflight.clear()
  stats.invalidate += n
  return n
}

export function getApiCacheStats() {
  return {
    enabled: cacheEnabled(),
    maxEntries: DEFAULT_MAX_ENTRIES,
    size: store.size,
    inflight: inflight.size,
    ...stats,
  }
}
