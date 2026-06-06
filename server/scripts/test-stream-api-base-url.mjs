import assert from 'node:assert/strict'
import { buildSignedDirectStreamPlaybackUrl } from '../src/lib/directStreamSigning.js'
import { buildPublicStreamProxyUrl } from '../src/lib/streamManifestRewrite.js'
import { channelToResponse } from '../src/channelNormalize.js'

const req = {
  protocol: 'https',
  get: (h) => (h === 'host' ? 'osmani-admin-api.onrender.com' : ''),
  headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'osmani-admin-api.onrender.com' },
}

process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_CUTOVER_ENABLED = '1'
process.env.DIRECT_STREAM_ROLLOUT_PERCENT = '100'

const prevBase = process.env.BASE_URL
const prevDirect = process.env.DIRECT_STREAM_BASE_URL
const prevStreamApi = process.env.STREAM_API_BASE_URL

try {
  process.env.BASE_URL = 'https://osmanitv.b-cdn.net'
  delete process.env.DIRECT_STREAM_BASE_URL
  delete process.env.STREAM_API_BASE_URL

  const direct = buildSignedDirectStreamPlaybackUrl(
    req,
    'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8',
    { referer: 'https://het140c.ycn-redirect.com' },
    { channelId: 16 },
  )
  assert.ok(direct.includes('osmani-admin-api.onrender.com/stream-direct'), `direct url: ${direct}`)
  assert.ok(!direct.includes('b-cdn.net'), `must not use bunny: ${direct}`)

  const proxy = buildPublicStreamProxyUrl(req, 'http://het103b.ycn-redirect.com/live/x/index.m3u8', {
    referer: 'https://het140c.ycn-redirect.com',
  })
  assert.ok(proxy.includes('osmani-admin-api.onrender.com/stream-proxy'), `proxy url: ${proxy}`)
  assert.ok(!proxy.includes('b-cdn.net'), `proxy must not use bunny: ${proxy}`)

  const ycn = channelToResponse(
    {
      id: 16,
      name: 'Bein 1 HD',
      url: 'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8',
      playerType: 'exo',
      referer: 'https://het140c.ycn-redirect.com',
      origin: 'https://het140c.ycn-redirect.com',
      isActive: true,
      showInApp: true,
      category: 'Sports',
      bottomTab: 'Sports',
      sortOrder: 1,
    },
    req,
  )
  for (const field of [
    'playbackUrl',
    'direct_stream_url',
    'proxy_playback_url',
    'proxy_fallback_url',
  ]) {
    const v = ycn[field]
    if (typeof v === 'string' && v.includes('/stream-')) {
      assert.ok(!v.includes('b-cdn.net'), `${field} must not be bunny: ${v}`)
      assert.ok(v.includes('osmani-admin-api.onrender.com'), `${field} must be API host`)
    }
  }
  if (ycn.streamProxy?.directPrimaryUrl) {
    assert.ok(!ycn.streamProxy.directPrimaryUrl.includes('b-cdn.net'))
  }

  process.env.STREAM_API_BASE_URL = 'https://osmani-admin-api.onrender.com'
  const explicit = buildSignedDirectStreamPlaybackUrl(req, 'http://example.com/a.m3u8', {}, { channelId: 1 })
  assert.ok(explicit.startsWith('https://osmani-admin-api.onrender.com/stream-direct'))
} finally {
  if (prevBase === undefined) delete process.env.BASE_URL
  else process.env.BASE_URL = prevBase
  if (prevDirect === undefined) delete process.env.DIRECT_STREAM_BASE_URL
  else process.env.DIRECT_STREAM_BASE_URL = prevDirect
  if (prevStreamApi === undefined) delete process.env.STREAM_API_BASE_URL
  else process.env.STREAM_API_BASE_URL = prevStreamApi
}

console.log('test-stream-api-base-url: OK')
