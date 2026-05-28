/**
 * Unit tests for selective Bunny vs proxy segment routing.
 */
import assert from 'node:assert/strict'
import {
  isProtectedSegmentTarget,
  getProtectedProviderConfig,
} from '../src/lib/streamProtectedProviders.js'
import {
  resolveSegmentRoute,
  createManifestSegmentUrlBuilder,
} from '../src/lib/streamSegmentDelivery.js'
import { resetStreamDeliveryMetrics, getStreamDeliveryMetricsSnapshot } from '../src/lib/streamDeliveryMetrics.js'

process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.BUNNY_STREAM_CDN_BASE_URL = 'https://osmanitv.b-cdn.net'
process.env.STREAM_SEGMENT_DELIVERY = 'bunny'
process.env.STREAM_SEGMENT_FORCE_PROXY = '0'
process.env.STREAM_SEGMENT_SELECTIVE_ROUTING = '1'
process.env.BASE_URL = 'https://osmani-admin-api.onrender.com'

resetStreamDeliveryMetrics()

const ycnMaster =
  'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8?t=abc&e=9999999999'
const ycnSeg =
  'http://h24.lanexa.online/2203124/58.js?918454578001/8203'
const ycnLoadcoreSeg = 'http://h24.loadcore.online/2203124/58.js?918454578001/9973'
const publicSeg = 'https://cdn.example.com/live/chunk00001.ts'

assert.equal(isProtectedSegmentTarget(ycnMaster, { referer: 'https://het140c.ycn-redirect.com' }), true)
assert.equal(isProtectedSegmentTarget(ycnSeg, {}, { rootUpstreamUrl: ycnMaster }), true)
assert.equal(isProtectedSegmentTarget(ycnLoadcoreSeg, {}, { rootUpstreamUrl: ycnMaster }), true)
assert.equal(isProtectedSegmentTarget(publicSeg, {}), false)

assert.equal(
  resolveSegmentRoute(publicSeg, {}, { rootUpstreamUrl: 'https://cdn.example.com/master.m3u8' }),
  'bunny',
)
assert.equal(resolveSegmentRoute(ycnSeg, {}, { rootUpstreamUrl: ycnMaster }), 'proxy')

const mockReq = { protocol: 'https', headers: {}, get: () => 'osmani-admin-api.onrender.com' }
const builder = createManifestSegmentUrlBuilder(mockReq, {
  channelId: '16',
  rootUpstreamUrl: ycnMaster,
  channelHeaders: { referer: 'https://het140c.ycn-redirect.com', userAgent: 'Exo' },
  useBunny: true,
})

const proxyUrl = builder.buildTargetUrl(ycnSeg, { referer: 'https://het140c.ycn-redirect.com' })
const loadcoreProxyUrl = builder.buildTargetUrl(ycnLoadcoreSeg, {
  referer: 'https://het140c.ycn-redirect.com',
})
const bunnyUrl = builder.buildTargetUrl(publicSeg, {})

assert.ok(proxyUrl.includes('/stream-proxy?'), `expected proxy, got ${proxyUrl}`)
assert.ok(loadcoreProxyUrl.includes('/stream-proxy?'), `expected proxy for loadcore, got ${loadcoreProxyUrl}`)
assert.ok(!loadcoreProxyUrl.includes('b-cdn.net'), 'loadcore must not use Bunny')
assert.ok(bunnyUrl.includes('osmanitv.b-cdn.net/hls/seg'), `expected bunny, got ${bunnyUrl}`)

const metrics = getStreamDeliveryMetricsSnapshot()
assert.ok(metrics.segment_routes_by_provider['h24.lanexa.online']?.proxy >= 1)
assert.ok(metrics.segment_routes_by_provider['cdn.example.com']?.bunny >= 1)

const cfg = getProtectedProviderConfig()
assert.ok(cfg.protected_host_suffixes.includes('ycn-redirect.com'))

console.log('verify-selective-segment-routing: OK')
