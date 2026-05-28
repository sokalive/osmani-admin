import assert from 'node:assert/strict'
import { normalizeUpstreamHeaders, isHlsManifestResponse } from '../src/lib/streamUpstreamHeaders.js'

const ycnUrl =
  'http://het103b.ycn-redirect.com/live/918454578001/index.m3u8?t=abc&e=9999999999'

const bad = normalizeUpstreamHeaders(
  {
    referer: 'https://het140c.ycn-redirect.com',
    origin: 'application/vnd.apple.mpegurl',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  },
  ycnUrl,
)

assert.equal(bad.origin, 'https://het140c.ycn-redirect.com')
assert.ok(!bad.origin.includes('mpegurl'))
assert.equal(bad.referer, 'https://het140c.ycn-redirect.com')
assert.ok(/Windows NT/i.test(bad.userAgent), 'ycn upstream must use desktop UA not Exo/mobile')
assert.ok(!/ExoPlayerLib/i.test(bad.userAgent))
assert.equal(bad.protectedUpstream, true)

const fromExoChannel = normalizeUpstreamHeaders(
  { referer: 'https://het140c.ycn-redirect.com', origin: '', userAgent: 'ExoPlayerLib/2.19.1' },
  ycnUrl,
)
assert.ok(/Windows NT/i.test(fromExoChannel.userAgent))

const publicUrl = 'https://cdn.example.com/live/chunk.ts'
const pub = normalizeUpstreamHeaders(
  { referer: '', origin: 'application/vnd.apple.mpegurl', userAgent: '' },
  publicUrl,
)
assert.equal(pub.origin, 'https://cdn.example.com')
assert.equal(pub.protectedUpstream, false)

assert.equal(isHlsManifestResponse('http://x/y.m3u8', 'text/html', '<!DOCTYPE html>'), false)
assert.equal(
  isHlsManifestResponse('http://x/y.js', 'application/vnd.apple.mpegurl', '<!DOCTYPE html>'),
  false,
)
assert.equal(isHlsManifestResponse('http://x/y.m3u8', 'text/plain', '#EXTM3U\n#EXTINF:1,\n'), true)

console.log('verify-ycn-upstream-headers: OK')
