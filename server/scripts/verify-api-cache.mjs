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
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return body
    },
  }
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

const key = buildApiCacheKey('channels', req)
assert.equal(key, 'channels|https://api.example.com|/api/channels')

const stats = getApiCacheStats()
assert.equal(stats.enabled, true)
assert.ok(stats.hit >= 1)

console.log('verify-api-cache: OK')
