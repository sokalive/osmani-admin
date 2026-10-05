/**
 * Additive tests: catalog parent/suffix authorization, rotating edges, tokenized HTTP classification.
 * Uses synthetic hostnames only — no Bein 4 or production provider playback.
 */
import assert from 'node:assert/strict'
import {
  _resetCatalogHttpBridgeHostsForTests,
  deriveCatalogProviderSuffix,
  evaluateStreamProxyUpstreamAccess,
  hostMatchesDnsLabelSuffix,
  syncCatalogHttpBridgeHostsFromChannels,
} from '../src/lib/streamProxyAllowlist.js'
import { isProtectedSegmentTarget } from '../src/lib/streamProtectedProviders.js'

const CATALOG_EDGE = 'http://edge1.example-provider.test/live/main.m3u8'
const ROOT = 'http://edge1.example-provider.test/live/main.m3u8?key=TOKEN123'

// 1) Exact catalog host
syncCatalogHttpBridgeHostsFromChannels([
  { url: CATALOG_EDGE, playerType: 'exo' },
])
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://edge1.example-provider.test/live/main.m3u8').allowed,
  true,
)
console.log('PASS 1 exact catalog host')

// 2) Rotating sibling under derived suffix
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://edge2.example-provider.test/live/seg001.ts').allowed,
  true,
)
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://edge2.example-provider.test/live/seg001.ts').reason,
  'authorized_catalog_provider_suffix',
)
console.log('PASS 2 rotating sibling edge under authorized suffix')

// 3) Malicious lookalike domains denied
assert.equal(hostMatchesDnsLabelSuffix('edge1.example-provider.test', 'example-provider.test'), true)
assert.equal(hostMatchesDnsLabelSuffix('example-provider.test.attacker.test', 'example-provider.test'), false)
assert.equal(hostMatchesDnsLabelSuffix('notexample-provider.test', 'example-provider.test'), false)
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://example-provider.test.attacker.test/seg.ts').allowed,
  false,
)
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://notexample-provider.test/seg.ts').allowed,
  false,
)
console.log('PASS 3 malicious suffix lookalikes denied')

// 4) Unauthorized external domain
assert.equal(evaluateStreamProxyUpstreamAccess('https://random-domain.example/').allowed, false)
console.log('PASS 4 unauthorized external domain denied')

// 5-7) SSRF blocks
assert.equal(evaluateStreamProxyUpstreamAccess('http://localhost/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://127.0.0.1/x').allowed, false)
assert.equal(evaluateStreamProxyUpstreamAccess('http://192.168.0.10/x').allowed, false)
console.log('PASS 5-7 localhost/private denied')

// 8) Tokenized HTTP on authorized host — allow via catalog, not misclassified as protected-only
const tokenAuth = 'http://edge1.example-provider.test/live/main.m3u8?key=ABC123'
assert.equal(isProtectedSegmentTarget(tokenAuth), false, 'token alone must not mark protected')
assert.equal(evaluateStreamProxyUpstreamAccess(tokenAuth).allowed, true)
console.log('PASS 8 tokenized HTTP on authorized host allowed')

// 9) Tokenized HTTP on unauthorized host — deny
const tokenEvil = 'http://random-domain.example/live.m3u8?key=ABC123'
assert.equal(isProtectedSegmentTarget(tokenEvil), false)
assert.equal(evaluateStreamProxyUpstreamAccess(tokenEvil).allowed, false)
console.log('PASS 9 tokenized HTTP on unauthorized host denied')

// 10) Manifest sibling edge via provider suffix segment rule
const siblingSeg = 'http://edge3.example-provider.test/live/5587.pdf'
const siblingAccess = evaluateStreamProxyUpstreamAccess(siblingSeg, {
  rootUpstreamUrl: ROOT,
  referer: 'http://edge1.example-provider.test/',
})
assert.equal(siblingAccess.allowed, true)
assert.ok(
  ['authorized_catalog_provider_suffix', 'authorized_provider_suffix_segment'].includes(
    siblingAccess.reason,
  ),
  `unexpected reason: ${siblingAccess.reason}`,
)
console.log('PASS 10 manifest sibling edge under provider suffix')

// 11) Unrelated host under authorized root — still denied unless HLS media chain (existing Bein path preserved separately)
assert.equal(
  evaluateStreamProxyUpstreamAccess('https://totally-unrelated.example/not-media', {
    rootUpstreamUrl: ROOT,
    referer: 'http://edge1.example-provider.test/',
  }).allowed,
  false,
)
console.log('PASS 11 unrelated non-media host denied')

// 12-14) Redirect revalidation is enforced in streamProxy route; unit-level host checks for redirect targets
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://edge2.example-provider.test/seg.ts', {
    rootUpstreamUrl: ROOT,
  }).allowed,
  true,
)
// Non-HLS off-host under authorized root stays denied (open proxy protection).
assert.equal(
  evaluateStreamProxyUpstreamAccess('http://evil.example/admin/dashboard', {
    rootUpstreamUrl: ROOT,
  }).allowed,
  false,
)
assert.equal(evaluateStreamProxyUpstreamAccess('http://127.0.0.1/seg.ts', { rootUpstreamUrl: ROOT }).allowed, false)
console.log('PASS 12-14 redirect-target host policy (pre-fetch validation)')

// Suffix derivation generic behavior
assert.equal(deriveCatalogProviderSuffix('h37.kavorexacloud.click'), 'kavorexacloud.click')
assert.equal(deriveCatalogProviderSuffix('example-provider.test'), null)
console.log('PASS suffix derivation')

_resetCatalogHttpBridgeHostsForTests([])
console.log('ALL ROTATING-EDGE STREAM-PROXY TESTS PASSED')
