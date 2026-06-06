/**
 * Unit tests for Mpingo player.php <base href> injection (no network).
 */
import assert from 'node:assert/strict'
import {
  injectMpingoHtmlBaseHref,
  isMpingoPlayerPageUrl,
  resolveMpingoHtmlBaseHref,
} from '../src/lib/streamMpingoHtmlBase.js'

const upstream = 'https://nur.mpingotv.com/v3/player.php?channel=1'

assert.equal(isMpingoPlayerPageUrl(upstream), true)
assert.equal(isMpingoPlayerPageUrl('https://nur.mpingotv.com/v3/subscriptions.php'), false)
assert.equal(isMpingoPlayerPageUrl('http://het103b.ycn-redirect.com/live/x/index.m3u8'), false)

assert.equal(resolveMpingoHtmlBaseHref(upstream), 'https://nur.mpingotv.com/v3/')

const html = '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'
const out = injectMpingoHtmlBaseHref(html, upstream)
assert.match(out, /<base href="https:\/\/nur\.mpingotv\.com\/v3\/" data-osmani-mpingo-base="1">/)
assert.equal(
  new URL('subscriptions.php?expired=1', 'https://osmani-admin-api.onrender.com/stream-direct?token=x').href,
  'https://osmani-admin-api.onrender.com/subscriptions.php?expired=1',
)
// With base tag in document, browser resolves relative to base href (simulated):
const baseMatch = out.match(/<base href="([^"]+)"/)
assert.ok(baseMatch)
assert.equal(
  new URL('subscriptions.php?expired=1', baseMatch[1]).href,
  'https://nur.mpingotv.com/v3/subscriptions.php?expired=1',
)
assert.equal(
  new URL('assets/js/offline.js', baseMatch[1]).href,
  'https://nur.mpingotv.com/v3/assets/js/offline.js',
)

const withExisting = '<html><head><base href="https://wrong.example/"></head></html>'
const replaced = injectMpingoHtmlBaseHref(withExisting, upstream)
assert.ok(!replaced.includes('wrong.example'))
assert.match(replaced, /data-osmani-mpingo-base="1"/)

const idempotent = injectMpingoHtmlBaseHref(out, upstream)
assert.equal(idempotent, out)

console.log('test-mpingo-html-base: OK')
