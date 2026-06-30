/**
 * In-memory JSON response cache for safe public GET catalog endpoints.
 * Singleton per process — module-level Maps only (never per-request).
 * Not a second HTTP cache layer — complements CDN + client polling reduction.
 */

const DEFAULT_MAX_ENTRIES = Math.min(
  256,
  Math.max(8, Number(process.env.API_CACHE_MAX_ENTRIES) || 48),
)

/** @type {Map<string, { body: unknown, status: number, expiresAt: number }>} */
const store = new Map()

/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map()

/** Bumped on namespace invalidation so in-flight handlers cannot re-store stale JSON. */
/** @type {Map<string, number>} */
const namespaceGeneration = new Map()

/** Leader finished without a cacheable JSON body — waiters must run the handler. */
const INFLIGHT_MISS = Object.freeze({ kind: 'INFLIGHT_MISS' })

const CACHE_EXEMPT_PATH_RE =
  /\/(subscription-status|subscription\/verify|update-check|runtime\/app-update)(\/|\?|$)/i

function generationFor(namespace) {
  return namespaceGeneration.get(namespace) || 0
}

function bumpNamespaceGeneration(namespace) {
  const next = generationFor(namespace) + 1
  namespaceGeneration.set(namespace, next)
  return next
}

const stats = {
  hit: 0,
  miss: 0,
  dedup: 0,
  inflight: 0,
  inflightMiss: 0,
  store: 0,
  evict: 0,
  invalidate: 0,
}

function isRenderProduction() {
  return (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
    String(process.env.RENDER || '').trim().toLowerCase() === 'true'
  )
}

function cacheEnabled() {
  if (isRenderProduction()) return false
  const raw = String(process.env.API_CACHE_ENABLED ?? '1').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function devDiagnosticsEnabled() {
  if (String(process.env.API_CACHE_DEBUG || '').trim() === '1') return true
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
}

function isCacheExemptRequest(req) {
  const url = String(req.originalUrl || req.url || '')
  return CACHE_EXEMPT_PATH_RE.test(url)
}

function requestIdFrom(req) {
  return (
    String(req.headers?.['x-request-id'] ?? req.headers?.['x-correlation-id'] ?? '').trim() ||
    null
  )
}

function deviceIdFrom(req) {
  const q = req.query && typeof req.query === 'object' ? req.query : {}
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const raw =
    q.device_id ??
    q.deviceId ??
    b.device_id ??
    b.deviceId ??
    req.headers?.['x-device-id'] ??
    ''
  const s = String(raw ?? '').trim()
  return s ? s.slice(0, 32) : null
}

function logCacheEvent(phase, req, namespace, extra = {}) {
  if (String(process.env.API_CACHE_LOG || '').trim() !== '1' && !devDiagnosticsEnabled()) return
  console.log(
    '[api-cache]',
    JSON.stringify({
      phase,
      namespace,
      endpoint: String(req.originalUrl || req.url || '').split('?')[0],
      method: req.method,
      requestId: requestIdFrom(req),
      deviceId: deviceIdFrom(req),
      ...extra,
    }),
  )
}

function isInflightMiss(entry) {
  return entry === INFLIGHT_MISS || entry?.kind === 'INFLIGHT_MISS'
}

function isCacheEntry(entry) {
  return entry != null && !isInflightMiss(entry) && typeof entry === 'object' && 'body' in entry
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

function releaseInflightMiss(settleInflight, key, req, namespace, reason) {
  stats.inflightMiss += 1
  logCacheEvent('cacheMiss', req, namespace, { key, reason })
  settleInflight(INFLIGHT_MISS)
}

/**
 * @param {string} namespace
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {number} ttlMs
 */
export function serveFromApiCacheOrContinue(namespace, req, res, next, ttlMs) {
  if (!cacheEnabled() || req.method !== 'GET' || isCacheExemptRequest(req)) {
    return next()
  }

  const key = buildApiCacheKey(namespace, req)
  const generationAtStart = generationFor(namespace)
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expiresAt > now) {
    stats.hit += 1
    logCacheEvent('cacheHit', req, namespace, { key })
    return sendCached(res, hit, 'HIT')
  }

  const pending = inflight.get(key)
  if (pending) {
    stats.dedup += 1
    stats.inflight += 1
    logCacheEvent('inflight', req, namespace, { key })
    void pending.then((entry) => {
      if (isInflightMiss(entry)) {
        logCacheEvent('inflightMiss', req, namespace, { key })
        return next()
      }
      if (!isCacheEntry(entry)) {
        logCacheEvent('inflightFallback', req, namespace, { key })
        return next()
      }
      logCacheEvent('cacheHit', req, namespace, { key, via: 'dedup' })
      return sendCached(res, entry, 'DEDUP')
    })
    return
  }

  stats.miss += 1
  logCacheEvent('cacheMiss', req, namespace, { key, phase: 'leader' })

  let settled = false
  /** @type {(v: unknown) => void} */
  let settleInflight = () => {}
  const inflightPromise = new Promise((resolve) => {
    settleInflight = resolve
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        inflight.delete(key)
        releaseInflightMiss(settleInflight, key, req, namespace, 'handler_timeout')
      }
    }, Math.max(60_000, ttlMs * 4))
    timer.unref?.()
  })
  inflight.set(key, inflightPromise)

  const finishUncached = () => {
    if (settled) return
    settled = true
    inflight.delete(key)
    releaseInflightMiss(settleInflight, key, req, namespace, 'response_not_cached')
  }
  if (typeof res.once === 'function') {
    res.once('finish', finishUncached)
    res.once('close', finishUncached)
  }

  const detachFinish = () => {
    if (typeof res.removeListener === 'function') {
      res.removeListener('finish', finishUncached)
      res.removeListener('close', finishUncached)
    }
  }

  const captureAndSend = (body, sendFn) => {
    detachFinish()
    const status = res.statusCode || 200
    if (!settled && status >= 200 && status < 300 && generationAtStart === generationFor(namespace)) {
      const entry = { body, status }
      remember(key, entry, ttlMs)
      settled = true
      settleInflight(entry)
      inflight.delete(key)
    } else if (!settled) {
      settled = true
      if (isCacheEntry({ body, status })) {
        settleInflight({ body, status })
      } else {
        releaseInflightMiss(settleInflight, key, req, namespace, 'non_cacheable_status')
      }
      inflight.delete(key)
    }
    if (devDiagnosticsEnabled()) {
      res.setHeader('X-Api-Cache', 'MISS')
    }
    return sendFn(body)
  }

  const origJson = res.json.bind(res)
  res.json = function jsonWithCache(body) {
    return captureAndSend(body, (b) => origJson(b))
  }

  const origSend = res.send?.bind(res)
  if (origSend) {
    res.send = function sendWithCache(body) {
      let parsed = body
      if (typeof body === 'string') {
        try {
          parsed = JSON.parse(body)
        } catch {
          detachFinish()
          if (!settled) {
            settled = true
            inflight.delete(key)
            releaseInflightMiss(settleInflight, key, req, namespace, 'non_json_send')
          }
          return origSend(body)
        }
      }
      return captureAndSend(parsed, (b) => origSend(typeof b === 'string' ? b : JSON.stringify(b)))
    }
  }

  next()
}

export function invalidateApiCacheNamespace(namespace) {
  bumpNamespaceGeneration(namespace)
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
    renderDisabled: isRenderProduction(),
    maxEntries: DEFAULT_MAX_ENTRIES,
    size: store.size,
    inflight: inflight.size,
    ...stats,
  }
}

/** Test helper */
export function __cacheInternalsForTests() {
  return { INFLIGHT_MISS, isInflightMiss, isCacheEntry, isRenderProduction, cacheEnabled }
}
