/**
 * Deterministic tests: HTTP+EXO HTTPS stream-proxy, allowlist, SSRF, HLS rewrite.
 */
import assert from 'node:assert/strict'
import { channelToResponse } from '../src/channelNormalize.js'
import {
  buildPublicStreamProxyUrl,
  rewriteManifest,
} from '../src/lib/streamManifestRewrite.js'
import { normalizeUpstreamHeaders, buildUpstreamFetchHeaders } from '../src/lib/streamUpstreamHeaders.js'
import {
  _resetCatalogHttpBridgeHostsForTests,
  assertHostnameResolvesPublic,
  evaluateStreamProxyUpstreamAccess,
  isBlockedHostname,
  isCleartextHttpBridgeUrl,
  isPrivateOrLocalIp,
  syncCatalogHttpBridgeHostsFromChannels,
} from '../src/lib/streamProxyAllowlist.js'
import { resolveSegmentRoute } from '../src/lib/streamSegmentDelivery.js'

const req = {
  protocol: 'https',
  get: (h) => (h === 'host' ? 'api.osmanitv.com' : ''),
  headers: { host: 'api.osmanitv.com' },
}

process.env.STREAM_API_BASE_URL = 'https://api.osmanitv.com'
process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.STREAM_PLAYBACK_FORCE_PROXY = '1'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '0'
process.env.BASE_URL = 'https://api.osmanitv.com'

_resetCatalogHttpBridgeHostsForTests([])

const BEIN_HTTP =
  'http://bein.mpilalivetv.com/bridge/bein-sports-1.m3u8?key=K2TV-791F'

// 1) HTTP + EXO → HTTPS stream-proxy playbackUrl
const httpExo = channelToResponse(
  {
    id: 16,
    name: 'Bein 1 HD',
    url: BEIN_HTTP,
    playerType: 'exo',
    isActive: true,
    showInApp: true,
    category: 'Sports',
    bottomTab: 'Sports',
    sortOrder: 1,
  },
  req,
)
assert.equal(httpExo.player_type, 'exo')
assert.ok(httpExo.playbackUrl.startsWith('https://api.osmanitv.com/stream-proxy?'))
assert.ok(httpExo.playbackUrl.includes(encodeURIComponent(BEIN_HTTP).slice(0, 40)) || httpExo.playbackUrl.includes('bein.mpilalivetv.com'))
assert.notEqual(httpExo.playbackUrl, httpExo.url)
assert.ok(!httpExo.playbackUrl.startsWith('http://bein'), 'must not prefer raw HTTP for Exo')
assert.ok(!/([?&])origin=/.test(httpExo.playbackUrl), 'cleartext bridge must omit Origin query')
console.log('PASS 1 HTTP+EXO playbackUrl is HTTPS stream-proxy without Origin')

// 2) HTTPS + EXO remains valid proxy/direct HTTPS
const httpsExo = channelToResponse(
  {
    id: 99,
    name: 'HTTPS EXO',
    url: 'https://cdn.example.com/live/index.m3u8',
    playerType: 'exo',
    isActive: true,
    showInApp: true,
    category: 'General',
    bottomTab: 'Home',
    sortOrder: 2,
  },
  req,
)
assert.ok(httpsExo.playbackUrl.startsWith('https://'))
assert.ok(httpsExo.playbackUrl.includes('/stream-proxy') || httpsExo.playbackUrl.includes('/stream-direct'))
console.log('PASS 2 HTTPS+EXO stays on HTTPS delivery')

// 3) HTTP + non-EXO (vlc) still uses HTTPS proxy (existing Osmani path), not raw cleartext preference
const httpVlc = channelToResponse(
  {
    id: 100,
    name: 'HTTP VLC',
    url: BEIN_HTTP,
    playerType: 'vlc',
    isActive: true,
    showInApp: true,
    category: 'Sports',
    bottomTab: 'Sports',
    sortOrder: 3,
  },
  req,
)
assert.equal(httpVlc.player_type, 'vlc')
assert.ok(httpVlc.playbackUrl.startsWith('https://api.osmanitv.com/stream-proxy?'))
console.log('PASS 3 HTTP+VLC keeps HTTPS proxy delivery')

// 4) HTTPS WebView Mpingo remains upstream/direct
const webview = channelToResponse(
  {
    id: 1,
    name: 'Azam',
    url: 'https://nur.mpingotv.com/v3/player.php?channel=1',
    playerType: 'webview',
    isActive: true,
    showInApp: true,
    category: 'General',
    bottomTab: 'Home',
    sortOrder: 4,
  },
  req,
)
assert.equal(webview.playbackUrl, 'https://nur.mpingotv.com/v3/player.php?channel=1')
assert.equal(webview.stream_delivery_effective, 'upstream')
console.log('PASS 4 HTTPS WebView remains upstream')

// Allowlist / SSRF
_resetCatalogHttpBridgeHostsForTests(['provider.example'])
assert.equal(evaluateStreamProxyUpstreamAccess('http://provider.example/live/a.m3u8').allowed, true)
assert.equal(evaluateStreamProxyUpstreamAccess('https://evil.example/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://127.0.0.1/').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://localhost/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://192.168.1.10/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://10.0.0.5/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://[::1]/').allowed, false)
assert.equal(isPrivateOrLocalIp('169.254.169.254'), true)
assert.equal(isBlockedHostname('metadata.google.internal'), true)
console.log('PASS 5-9 allowlist + SSRF host blocks')

// Builtin Bein host allowed
assert.equal(isCleartextHttpBridgeUrl(BEIN_HTTP), true)
assert.equal(evaluateStreamProxyUpstreamAccess(BEIN_HTTP).allowed, true)
console.log('PASS allowlisted cleartext Bein host')

// Catalog sync
syncCatalogHttpBridgeHostsFromChannels([
  { url: 'http://new-provider.test/live.m3u8', playerType: 'exo' },
])
assert.equal(evaluateStreamProxyUpstreamAccess('http://new-provider.test/live.m3u8').allowed, true)
console.log('PASS catalog HTTP host allowlisted')

// Same-host segment under authorized root
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://bein.mpilalivetv.com/bridge/seg.ts', {
    referer: 'http://bein.mpilalivetv.com/',
  }).allowed,
  true,
)
// Off-host media segment under authorized root referer (Bein obfuscated .pdf)
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://h26.carvelocity.buzz/002/1/5348.pdf', {
    referer: 'http://bein.mpilalivetv.com/',
  }).allowed,
  true,
)
// Unauthorized off-host denied
assert.equal(
  evaluateStreamProxyUpstreamAccess('https://evil.example/seg.ts', {
    referer: 'https://unrelated.example/',
  }).allowed,
  false,
)
console.log('PASS 12-14 segment host policy')

// Cleartext headers: desktop UA, omit Origin
const hdr = normalizeUpstreamHeaders({ userAgent: 'ExoPlayerLib/2.19.1', origin: 'http://bein.mpilalivetv.com' }, BEIN_HTTP)
assert.equal(hdr.omitOrigin, true)
assert.equal(hdr.origin, '')
assert.ok(/Windows NT/i.test(hdr.userAgent))
assert.ok(/Chrome\/139/i.test(hdr.userAgent), 'cleartext bridge prefers current desktop Chrome UA')
const built = buildUpstreamFetchHeaders(hdr, { upstreamUrl: BEIN_HTTP, manifest: true })
assert.equal(built.headers.Origin, undefined)
assert.ok(built.headers.Referer.includes('bein.mpilalivetv.com'))
console.log('PASS cleartext bridge omits Origin + desktop UA')

// Manifest relative segment rewrite
const { text, rewriteCount } = rewriteManifest(
  '#EXTM3U\n#EXTINF:4,\nseg001.ts\n',
  'http://bein.mpilalivetv.com/bridge/index.m3u8',
  hdr,
  (absolute, h) => buildPublicStreamProxyUrl(req, absolute, h),
)
assert.ok(rewriteCount >= 1)
assert.ok(text.includes('https://api.osmanitv.com/stream-proxy?'))
assert.ok(text.includes('seg001.ts') || text.includes(encodeURIComponent('seg001.ts')) || text.includes('bridge'))
console.log('PASS 10-12 manifest relative segment resolves to HTTPS proxy')

// Cleartext root forces proxy segment route
assert.equal(
  resolveSegmentRoute('http://h26.carvelocity.buzz/x/1.pdf', hdr, { rootUpstreamUrl: BEIN_HTTP }),
  'proxy',
)
console.log('PASS cleartext root segments force proxy (not Bunny)')

// DNS public resolve smoke (example.com)
const addrs = await assertHostnameResolvesPublic('example.com')
assert.ok(addrs.length >= 1)
let denied = false
try {
  await assertHostnameResolvesPublic('127.0.0.1')
} catch {
  denied = true
}
assert.equal(denied, true)
console.log('PASS DNS SSRF resolve guard')

console.log('ALL HTTP+EXO STREAM-PROXY TESTS PASSED')
