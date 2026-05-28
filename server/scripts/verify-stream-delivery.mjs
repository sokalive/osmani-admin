/**
 * Unit tests for stream delivery rollout + signing (no network).
 */
import assert from 'node:assert/strict'
import {
  createDirectStreamToken,
  verifyDirectStreamToken,
  buildSignedDirectStreamPlaybackUrl,
} from '../src/lib/directStreamSigning.js'
import {
  buildChannelStreamDelivery,
  getStreamDeliveryHealthSnapshot,
  getStreamDeliveryMode,
} from '../src/lib/streamDelivery.js'
import { isChannelEligibleForDirectPlayback } from '../src/lib/streamDeliveryRollout.js'
import { resetStreamDeliveryMetrics } from '../src/lib/streamDeliveryMetrics.js'

process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.BASE_URL = 'https://osmani-admin-api.onrender.com'
process.env.DIRECT_STREAM_CUTOVER_ENABLED = '1'
process.env.STREAM_PLAYBACK_FORCE_PROXY = '0'
process.env.DIRECT_STREAM_ROLLOUT_PERCENT = '0'
process.env.DIRECT_STREAM_ROLLOUT_CHANNEL_IDS = '42,99'

resetStreamDeliveryMetrics()

assert.equal(getStreamDeliveryMode(), 'hybrid')

const upstream = 'https://example-cdn.com/live/chan/playlist.m3u8'
const created = createDirectStreamToken({
  upstreamUrl: upstream,
  referer: 'https://provider.example/',
  channelId: '42',
})
assert.equal(created.ok, true)

const verified = verifyDirectStreamToken(created.token)
assert.equal(verified.ok, true)

const allowlisted = isChannelEligibleForDirectPlayback('42')
assert.equal(allowlisted.eligible, true)
assert.equal(allowlisted.reason, 'allowlist')

const excluded = isChannelEligibleForDirectPlayback('100')
assert.equal(excluded.eligible, false)

const mockReq = {
  protocol: 'https',
  headers: {},
  get: () => 'osmani-admin-api.onrender.com',
}

const deliveryAllow = buildChannelStreamDelivery(mockReq, {
  id: 42,
  url: upstream,
  referer: 'https://provider.example/',
  backupStream1: '',
  backupStream2: '',
})
assert.equal(deliveryAllow.stream_delivery_effective, 'direct')
assert.ok(deliveryAllow.playbackUrl.includes('/stream-direct'))
assert.ok(deliveryAllow.proxy_playback_url.includes('/stream-proxy'))

const deliveryBlock = buildChannelStreamDelivery(mockReq, {
  id: 100,
  url: upstream,
  backupStream1: '',
  backupStream2: '',
})
assert.equal(deliveryBlock.stream_delivery_effective, 'proxy')
assert.ok(deliveryBlock.playbackUrl.includes('/stream-proxy'))

process.env.STREAM_PLAYBACK_FORCE_PROXY = '1'
const rollback = buildChannelStreamDelivery(mockReq, {
  id: 42,
  url: upstream,
  backupStream1: '',
  backupStream2: '',
})
assert.equal(rollback.stream_delivery_effective, 'proxy')
assert.ok(rollback.playbackUrl.includes('/stream-proxy'))

const health = getStreamDeliveryHealthSnapshot()
assert.equal(health.cutover_enabled, true)

console.log('verify-stream-delivery: OK')
