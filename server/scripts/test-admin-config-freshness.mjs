/**
 * Admin-to-app freshness. Fixtures only — no database writes and no provider calls.
 * Run: node scripts/test-admin-config-freshness.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveSyncBus } from '../src/lib/liveSyncBus.js'
import { wireApiCacheInvalidation } from '../src/lib/apiCacheInvalidation.js'
import { wireConfigCacheListeners } from '../src/lib/configCacheListeners.js'
import {
  invalidateApiCacheNamespace,
  serveFromApiCacheOrContinue,
} from '../src/lib/apiResponseCache.js'
import { applySensitiveJsonGetNoStore } from '../src/middleware/sensitiveApiCacheControl.js'
import { redactRelayError } from '../src/lib/pgListenRelay.js'
import { writeSseEvent } from '../src/lib/sseFlush.js'
import { invalidateTrialWatchSettingsCache } from '../src/lib/trialWatchSettings.js'

process.env.API_CACHE_ENABLED = '1'
process.env.NODE_ENV = 'test'
process.env.RENDER = ''
process.env.BASE_URL = 'https://api.osmanitv.com'

wireApiCacheInvalidation()
wireConfigCacheListeners()

const root = dirname(fileURLToPath(import.meta.url))

function mockRes() {
  const headers = {}
  return {
    statusCode: 200,
    headersSent: true,
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

function request(url) {
  return {
    method: 'GET',
    originalUrl: url,
    url,
    headers: {},
    query: {},
    get: () => 'api.osmanitv.com',
  }
}

const snap = liveSyncBus.snapshot()
assert.equal(typeof snap.bootId, 'string')
assert.ok(snap.bootId.startsWith('osmani-'))
const versionBefore = snap.configVersion
const published = liveSyncBus.publish('config.plans_changed', { topics: ['config'], action: 'updated', planId: 10 })
assert.equal(published.configVersion, versionBefore + 1)
assert.equal(published.bootId, snap.bootId)

const analyticsBefore = liveSyncBus.snapshot().analyticsVersion
const configBeforeStats = liveSyncBus.snapshot().configVersion
liveSyncBus.publish('config.notifications_changed', { topics: ['analytics'], action: 'stats_synced' })
assert.equal(liveSyncBus.snapshot().configVersion, configBeforeStats)
assert.equal(liveSyncBus.snapshot().analyticsVersion, analyticsBefore + 1)

const notificationsSrc = readFileSync(join(root, '../src/lib/runtimeNotifications.js'), 'utf8')
assert.ok(notificationsSrc.includes("action === 'stats_synced' ? ['analytics'] : ['config']"))

const popupSrc = readFileSync(join(root, '../src/routes/realtimeSettings.js'), 'utf8')
const popupFn = popupSrc.slice(
  popupSrc.indexOf('async function savePopupSettings'),
  popupSrc.indexOf('function getPrimaryStreamUrl'),
)
assert.ok(popupFn.indexOf("error: 'title is required'") < popupFn.indexOf('publishWithLog'))
assert.ok(popupFn.indexOf('await saveSettings') < popupFn.indexOf('publishWithLog'))

const plansReq = request('/plans')
invalidateApiCacheNamespace('plans')
const slow = mockRes()
serveFromApiCacheOrContinue('plans', plansReq, slow, () => {}, 30_000)
liveSyncBus.publish('config.plans_changed', { topics: ['config'], action: 'updated', planId: 11 })
slow.json({ price: 1 })
let reread = false
const after = mockRes()
serveFromApiCacheOrContinue('plans', plansReq, after, () => {
  reread = true
  after.json({ price: 4000 })
}, 30_000)
assert.equal(reread, true)
assert.equal(after.body.price, 4000)

invalidateApiCacheNamespace('popup-settings')
const popupReq = request('/popup-settings')
const storedPopup = mockRes()
serveFromApiCacheOrContinue('popup-settings', popupReq, storedPopup, () => {
  storedPopup.json({ title: 'stale' })
}, 30_000)
assert.equal(storedPopup.body.title, 'stale')
liveSyncBus.replay({
  event: 'popup_settings_changed',
  payload: { topics: ['config'], title: 'fresh' },
  configVersion: 50,
})
let popupMiss = false
const popupAfter = mockRes()
serveFromApiCacheOrContinue('popup-settings', popupReq, popupAfter, () => {
  popupMiss = true
  popupAfter.json({ title: 'fresh' })
}, 30_000)
assert.equal(popupMiss, true)
assert.equal(popupAfter.body.title, 'fresh')

function headerFor(path) {
  const headers = {}
  const req = { method: 'GET', url: path, baseUrl: '/api' }
  const res = { setHeader(k, v) { headers[k] = v } }
  applySensitiveJsonGetNoStore(req, res, () => {})
  return headers['Cache-Control'] || ''
}
for (const path of ['/plans', '/popup-settings', '/whatsapp-settings', '/channels', '/banners', '/runtime/app-modes', '/runtime/trial-watch']) {
  assert.ok(headerFor(path).includes('no-store'), path)
}

assert.equal(
  redactRelayError(new Error('connect failed postgres://user:secret@db.example/osmani')),
  'connect failed [redacted]',
)

const frames = []
writeSseEvent({
  write(chunk) { frames.push(chunk) },
  flush() { frames.push('FLUSH') },
  socket: { uncork() { frames.push('UNCORK') } },
}, 'snapshot', { bootId: 'osmani-test', configVersion: 1 })
assert.equal(frames[0], 'event: snapshot\n')
assert.ok(frames[1].includes('"bootId":"osmani-test"'))
assert.ok(frames.includes('FLUSH'))
assert.ok(frames.includes('UNCORK'))

invalidateTrialWatchSettingsCache()

const relaySrc = readFileSync(join(root, '../src/lib/pgListenRelay.js'), 'utf8')
assert.ok(relaySrc.includes('scheduleReconnect'))
assert.ok(relaySrc.includes('pg_notify failed'))

console.log('PASS admin config freshness')
