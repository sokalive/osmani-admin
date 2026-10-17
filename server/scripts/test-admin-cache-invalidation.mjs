/**
 * Admin catalog cache invalidation must cover every public GET namespace.
 */
import assert from 'node:assert/strict'
import { cacheNamespacesForLiveSyncEvent, wireApiCacheInvalidation } from '../src/lib/apiCacheInvalidation.js'
import { liveSyncBus } from '../src/lib/liveSyncBus.js'
import {
  invalidateApiCacheNamespace,
  serveFromApiCacheOrContinue,
} from '../src/lib/apiResponseCache.js'

assert.deepEqual(cacheNamespacesForLiveSyncEvent('config.channels_changed'), [
  'channels',
  'runtime-app-modes',
])
assert.deepEqual(cacheNamespacesForLiveSyncEvent('config.banners_changed'), ['banners'])
assert.ok(cacheNamespacesForLiveSyncEvent('popup_settings_changed').includes('popup-settings'))
assert.ok(cacheNamespacesForLiveSyncEvent('popup_settings_changed').includes('settings-popup'))
assert.ok(cacheNamespacesForLiveSyncEvent('whatsapp_settings_changed').includes('whatsapp-settings'))
assert.deepEqual(cacheNamespacesForLiveSyncEvent('unrelated.event'), [])

process.env.API_CACHE_ENABLED = '1'
process.env.NODE_ENV = 'test'
process.env.RENDER = ''
process.env.BASE_URL = 'https://api.osmanitv.com'
wireApiCacheInvalidation()

function mockRes() {
  const headers = {}
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) {
      headers[k] = v
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    once() {},
    removeListener() {},
  }
}

invalidateApiCacheNamespace('popup-settings')
const req = {
  method: 'GET',
  originalUrl: '/popup-settings',
  url: '/popup-settings',
  headers: {},
  query: {},
  get: () => 'api.osmanitv.com',
}
let stored
const res = mockRes()
res.json = (body) => {
  stored = body
  return res
}
serveFromApiCacheOrContinue('popup-settings', req, res, () => {
  res.json({ title: 'before' })
}, 30_000)

const t0 = Date.now()
liveSyncBus.publish('popup_settings_changed', { topics: ['config'], title: 'after' })
const invalidatedAt = Date.now() - t0

const res2 = mockRes()
let sawHandler = false
serveFromApiCacheOrContinue('popup-settings', req, res2, () => {
  sawHandler = true
  res2.json({ title: 'after' })
}, 30_000)
assert.equal(sawHandler, true, 'popup-settings must miss cache immediately after popup_settings_changed')
assert.ok(invalidatedAt < 50, `invalidation took ${invalidatedAt}ms`)
assert.equal(stored.title, 'before')

console.log('PASS popup-settings cache drops on popup_settings_changed')
console.log('ALL ADMIN CACHE INVALIDATION CHECKS PASSED')
