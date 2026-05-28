/**
 * Unit tests for direct stream signing + delivery strategy (no network).
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
  isStreamPlaybackForceProxy,
} from '../src/lib/streamDelivery.js'

process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.STREAM_PLAYBACK_FORCE_PROXY = '1'
process.env.BASE_URL = 'https://osmani-admin-api.onrender.com'

assert.equal(getStreamDeliveryMode(), 'hybrid')
assert.equal(isStreamPlaybackForceProxy(), true)

const upstream = 'https://example-cdn.com/live/chan/playlist.m3u8'
const created = createDirectStreamToken({
  upstreamUrl: upstream,
  referer: 'https://provider.example/',
  channelId: '42',
})
assert.equal(created.ok, true)

const verified = verifyDirectStreamToken(created.token)
assert.equal(verified.ok, true)
assert.equal(verified.payload.upstreamUrl, upstream)
assert.equal(verified.payload.channelId, '42')

const mockReq = {
  protocol: 'https',
  headers: {},
  get: () => 'osmani-admin-api.onrender.com',
}
const signedUrl = buildSignedDirectStreamPlaybackUrl(
  mockReq,
  upstream,
  { referer: 'https://provider.example/' },
  { channelId: '42' },
)
assert.ok(signedUrl.includes('/stream-direct?token='))

const delivery = buildChannelStreamDelivery(mockReq, {
  id: 1,
  url: upstream,
  referer: 'https://provider.example/',
  backupStream1: '',
  backupStream2: '',
})
assert.equal(delivery.stream_delivery_mode, 'hybrid')
assert.ok(delivery.playbackUrl.includes('/stream-proxy'))
assert.ok(delivery.direct_stream_url.includes('/stream-direct'))
assert.equal(delivery.playbackUrl, delivery.streamProxy.primaryUrl)

const health = getStreamDeliveryHealthSnapshot()
assert.equal(health.ok, true)
assert.equal(health.playback_force_proxy, true)
assert.equal(health.production_cutover, false)

console.log('verify-stream-delivery: OK')
