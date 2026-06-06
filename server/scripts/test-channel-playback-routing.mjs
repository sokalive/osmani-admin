/**
 * Unit tests for player-type-aware playback routing metadata (no network).
 */
import assert from 'node:assert/strict'
import { channelToResponse } from '../src/channelNormalize.js'

const req = {
  protocol: 'https',
  get: (h) => (h === 'host' ? 'osmani-admin-api.onrender.com' : ''),
  headers: {},
}

process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.BASE_URL = 'https://osmani-admin-api.onrender.com'
process.env.DIRECT_STREAM_CUTOVER_ENABLED = '1'
process.env.DIRECT_STREAM_ROLLOUT_PERCENT = '100'

const mpingoWebview = channelToResponse(
  {
    id: 1,
    name: 'Azam 1 HD',
    url: 'https://nur.mpingotv.com/v3/player.php?channel=1',
    playerType: 'webview',
    isActive: true,
    showInApp: true,
    category: 'General',
    bottomTab: 'Home',
    sortOrder: 1,
  },
  req,
)

assert.equal(mpingoWebview.playerType, 'webview')
assert.equal(mpingoWebview.playbackUrl, 'https://nur.mpingotv.com/v3/player.php?channel=1')
assert.equal(mpingoWebview.stream_delivery_effective, 'upstream')
assert.equal(mpingoWebview.playback_source, 'upstream')
assert.ok(mpingoWebview.direct_stream_url?.includes('/stream-direct'))
assert.ok(mpingoWebview.proxy_playback_url?.includes('/stream-proxy'))
assert.equal(mpingoWebview.proxy_fallback_url, mpingoWebview.proxy_playback_url)

const ycnExo = channelToResponse(
  {
    id: 16,
    name: 'Bein 1 HD',
    url: 'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8?t=x&e=1',
    playerType: 'exo',
    referer: 'https://het140c.ycn-redirect.com',
    origin: 'https://het140c.ycn-redirect.com',
    isActive: true,
    showInApp: true,
    category: 'Sports',
    bottomTab: 'Sports',
    sortOrder: 2,
  },
  req,
)

assert.equal(ycnExo.playerType, 'exo')
assert.ok(
  ycnExo.playbackUrl.includes('/stream-direct') || ycnExo.playbackUrl.includes('/stream-proxy'),
  'ycn exo playbackUrl must be signed direct or proxy',
)
assert.notEqual(ycnExo.playbackUrl, ycnExo.url, 'ycn exo must not use raw upstream as playbackUrl')
assert.equal(ycnExo.proxy_fallback_url, ycnExo.proxy_playback_url)

console.log('test-channel-playback-routing: OK')
