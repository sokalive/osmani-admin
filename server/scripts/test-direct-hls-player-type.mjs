/**
 * Unit tests for direct_hls player type (no network, no DB writes).
 */
import assert from 'node:assert/strict'
import {
  channelToResponse,
  mergeChannelRecord,
  normalizePlayerType,
  parseChannelInput,
} from '../src/channelNormalize.js'

const req = {
  protocol: 'https',
  get: (h) => (h === 'host' ? 'api.osmanitv.com' : ''),
  headers: {},
}

process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.BASE_URL = 'https://api.osmanitv.com'
process.env.DIRECT_STREAM_CUTOVER_ENABLED = '1'
process.env.DIRECT_STREAM_ROLLOUT_PERCENT = '100'

const SIGNED_HLS_URL =
  'https://example-cdn.test/hls/stream-id/index.m3u8?p=abc123&sig=token%2Bvalue'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('PASS', name)
  } catch (e) {
    failed += 1
    console.error('FAIL', name, e?.message || e)
  }
}

test('normalizePlayerType: direct_hls aliases', () => {
  assert.equal(normalizePlayerType('direct_hls'), 'direct_hls')
  assert.equal(normalizePlayerType('Direct HLS'), 'direct_hls')
  assert.equal(normalizePlayerType('directhls'), 'direct_hls')
  assert.equal(normalizePlayerType('direct-hls'), 'direct_hls')
})

test('normalizePlayerType: existing players unchanged', () => {
  assert.equal(normalizePlayerType('exo'), 'exo')
  assert.equal(normalizePlayerType('Exo'), 'exo')
  assert.equal(normalizePlayerType('webview'), 'webview')
  assert.equal(normalizePlayerType('WebView'), 'webview')
  assert.equal(normalizePlayerType('vlc'), 'vlc')
  assert.equal(normalizePlayerType('native'), 'native')
  assert.equal(normalizePlayerType('ijk'), 'ijk')
  assert.equal(normalizePlayerType('IJK'), 'ijk')
})

test('normalizePlayerType: unknown still falls back to exo', () => {
  assert.equal(normalizePlayerType('unknown_player'), 'exo')
})

test('parseChannelInput + mergeChannelRecord persist direct_hls with blank headers', () => {
  const parsed = parseChannelInput(
    {
      name: 'Direct Test',
      url: SIGNED_HLS_URL,
      playerType: 'direct_hls',
      referer: '',
      userAgent: '',
      origin: '',
      category: 'Home',
      bottomTab: 'Home',
    },
    null,
    null,
  )
  assert.equal(parsed.playerType, 'direct_hls')
  assert.equal(parsed.referer, '')
  assert.equal(parsed.userAgent, '')
  assert.equal(parsed.origin, '')
  const row = mergeChannelRecord(null, parsed, 99999, new Date().toISOString())
  assert.equal(row.playerType, 'direct_hls')
  assert.equal(row.url, SIGNED_HLS_URL)
  assert.equal(row.referer, '')
  assert.equal(row.userAgent, '')
})

test('channelToResponse: direct_hls preserves signed URL and query exactly', () => {
  const api = channelToResponse(
    {
      id: 99999,
      name: 'Direct HLS Channel',
      url: SIGNED_HLS_URL,
      playerType: 'direct_hls',
      referer: '',
      origin: '',
      userAgent: '',
      isActive: true,
      showInApp: true,
      category: 'Home',
      bottomTab: 'Home',
      sortOrder: 1,
    },
    req,
  )
  assert.equal(api.playerType, 'direct_hls')
  assert.equal(api.player_type, 'direct_hls')
  assert.equal(api.player_type_configured, 'direct_hls')
  assert.equal(api.url, SIGNED_HLS_URL)
  assert.equal(api.playbackUrl, SIGNED_HLS_URL)
  assert.equal(api.stream_url, SIGNED_HLS_URL)
  assert.equal(api.direct_stream_url, SIGNED_HLS_URL)
  assert.equal(api.referer, '')
  assert.equal(api.origin, '')
  assert.equal(api.userAgent, '')
  assert.equal(api.playback_source, 'direct_hls')
  assert.equal(api.proxy_playback_url, '')
  assert.ok(!api.playbackUrl.includes('/stream-proxy'))
  assert.ok(!api.playbackUrl.includes('/stream-direct'))
})

test('channelToResponse: exo ycn routing unchanged', () => {
  const ycnUrl = 'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8?t=x&e=1'
  const api = channelToResponse(
    {
      id: 16,
      name: 'Bein 1 HD',
      url: ycnUrl,
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
  assert.equal(api.playerType, 'exo')
  assert.notEqual(api.playbackUrl, ycnUrl)
  assert.ok(
    api.playbackUrl.includes('/stream-direct') || api.playbackUrl.includes('/stream-proxy'),
    'exo must still use signed direct or proxy playback',
  )
})

test('channelToResponse: webview mpingo routing unchanged', () => {
  const api = channelToResponse(
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
  assert.equal(api.playerType, 'webview')
  assert.equal(api.playbackUrl, 'https://nur.mpingotv.com/v3/player.php?channel=1')
})

test('channelToResponse: vlc/native/ijk unchanged passthrough', () => {
  for (const pt of ['vlc', 'native', 'ijk']) {
    const api = channelToResponse(
      {
        id: 100,
        name: `${pt} channel`,
        url: 'https://cdn.example.test/live/main.m3u8',
        playerType: pt,
        isActive: true,
        showInApp: true,
        category: 'Home',
        bottomTab: 'Home',
        sortOrder: 1,
      },
      req,
    )
    assert.equal(api.playerType, pt)
    assert.equal(api.player_type_configured, pt)
  }
})

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
