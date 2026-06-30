/**
 * Unit tests for in-memory API response cache (no HTTP).
 */
import assert from 'node:assert/strict'
import {
  buildApiCacheKey,
  getApiCacheStats,
  invalidateApiCacheNamespace,
  invalidateAllApiCache,
  serveFromApiCacheOrContinue,
} from '../src/lib/apiResponseCache.js'

function mockReq(url = '/api/channels') {
  return {
    method: 'GET',
    originalUrl: url,
    url,
    protocol: 'https',
    headers: {},
    get: (h) => (h === 'host' ? 'api.example.com' : undefined),
  }
}

function mockRes() {
  const headers = {}
  const listeners = { finish: [], close: [] }
  const res = {
    statusCode: 200,
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v
    },
    status(code) {
      this.statusCode = code
      return this
    },
    once(ev, fn) {
      if (listeners[ev]) listeners[ev].push(fn)
    },
    removeListener(ev, fn) {
      if (!listeners[ev]) return
      listeners[ev] = listeners[ev].filter((f) => f !== fn)
    },
    emitFinish() {
      for (const fn of [...listeners.finish]) fn()
      for (const fn of [...listeners.close]) fn()
    },
    json(body) {
      this.body = body
      this.emitFinish()
      return body
    },
    end() {
      this.emitFinish()
    },
  }
  return res
}

process.env.BASE_URL = 'https://api.example.com'
process.env.API_CACHE_ENABLED = '1'
invalidateAllApiCache()

let handlerCalls = 0
const req = mockReq()
const res1 = mockRes()
const next = () => {
  handlerCalls += 1
  res1.json({ channels: [1] })
}

serveFromApiCacheOrContinue('channels', req, res1, next, 60_000)
assert.equal(handlerCalls, 1)
assert.deepEqual(res1.body, { channels: [1] })

const res2 = mockRes()
serveFromApiCacheOrContinue('channels', req, res2, () => {
  throw new Error('handler should not run on HIT')
}, 60_000)
assert.deepEqual(res2.body, { channels: [1] })
assert.equal(res2.headers['x-api-cache'], 'HIT')

invalidateApiCacheNamespace('channels')
const res3 = mockRes()
let callsAfterInvalidate = 0
serveFromApiCacheOrContinue('channels', req, res3, () => {
  callsAfterInvalidate += 1
  res3.json({ channels: [2] })
}, 60_000)
assert.equal(callsAfterInvalidate, 1)

// In-flight handler must not re-cache after invalidation (generation bump).
invalidateAllApiCache()
const resRace = mockRes()
let raceHandlerDone = null
serveFromApiCacheOrContinue('channels', req, resRace, () => {
  raceHandlerDone = () => {
    resRace.json({ channels: [99] })
  }
}, 60_000)
assert.equal(typeof raceHandlerDone, 'function')
invalidateApiCacheNamespace('channels')
raceHandlerDone()
const resAfterRace = mockRes()
let callsAfterRace = 0
serveFromApiCacheOrContinue('channels', req, resAfterRace, () => {
  callsAfterRace += 1
  resAfterRace.json({ channels: [3] })
}, 60_000)
assert.equal(callsAfterRace, 1, 'stale in-flight response must not be stored after invalidation')

// Leader finishes without JSON — dedup waiter must not crash (runs handler).
invalidateAllApiCache()
const resLeader = mockRes()
let leaderHandler = null
serveFromApiCacheOrContinue('channels', req, resLeader, () => {
  leaderHandler = () => resLeader.end()
}, 60_000)
assert.equal(typeof leaderHandler, 'function')
const resWaiter = mockRes()
let waiterHandlerCalls = 0
serveFromApiCacheOrContinue('channels', req, resWaiter, () => {
  waiterHandlerCalls += 1
  resWaiter.json({ channels: [42] })
}, 60_000)
assert.equal(waiterHandlerCalls, 0, 'waiter should attach to inflight first')
leaderHandler()
await new Promise((r) => setImmediate(r))
assert.equal(waiterHandlerCalls, 1, 'waiter must run handler after inflight miss')
assert.deepEqual(resWaiter.body, { channels: [42] })

// Exempt subscription / update-check paths never enter cache layer.
let exemptCalls = 0
const exemptReq = mockReq('/api/subscription-status?device_id=abc')
serveFromApiCacheOrContinue('channels', exemptReq, mockRes(), () => {
  exemptCalls += 1
}, 60_000)
assert.equal(exemptCalls, 1, 'subscription-status must bypass cache')

const key = buildApiCacheKey('channels', req)
assert.equal(key, 'channels|https://api.example.com|/api/channels')

const stats = getApiCacheStats()
assert.equal(stats.enabled, true)
assert.ok(stats.hit >= 1)

console.log('verify-api-cache: OK')
