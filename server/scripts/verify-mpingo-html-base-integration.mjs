/**
 * Integration check: real Mpingo upstream HTML + server-side base injection (no local DB).
 */
import assert from 'node:assert/strict'
import { injectMpingoHtmlBaseHref, resolveMpingoHtmlBaseHref } from '../src/lib/streamMpingoHtmlBase.js'

const upstream = 'https://nur.mpingotv.com/v3/player.php?channel=1'
const raw = await fetch(upstream, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  },
}).then((r) => r.text())

assert.equal(resolveMpingoHtmlBaseHref(upstream), 'https://nur.mpingotv.com/v3/')

const proxied = injectMpingoHtmlBaseHref(raw, upstream)
const baseMatch = proxied.match(/<base href="([^"]+)"[^>]*data-osmani-mpingo-base="1"/i)
assert.ok(baseMatch, 'injected base tag missing')
assert.equal(baseMatch[1], 'https://nur.mpingotv.com/v3/')

const subs = new URL('subscriptions.php?expired=1', baseMatch[1]).href
const asset = new URL('assets/js/offline.js', baseMatch[1]).href
assert.equal(subs, 'https://nur.mpingotv.com/v3/subscriptions.php?expired=1')
assert.equal(asset, 'https://nur.mpingotv.com/v3/assets/js/offline.js')

console.log(
  JSON.stringify(
    {
      ok: true,
      upstream,
      base_href: baseMatch[1],
      subscriptions_resolves_to: subs,
      assets_resolves_to: asset,
      upstream_bytes: raw.length,
      proxied_bytes: proxied.length,
    },
    null,
    2,
  ),
)
