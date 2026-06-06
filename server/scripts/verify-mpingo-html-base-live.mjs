/**
 * Live verification: Mpingo stream-direct HTML includes <base href> for nur.mpingotv.com/v3/.
 * Usage: node scripts/verify-mpingo-html-base-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)

const channels = await fetch(`${API}/api/channels`).then((r) => r.json())
const mpingo = channels.filter((c) => String(c.url || '').includes('mpingotv.com'))
const ycn = channels.filter((c) => String(c.url || '').includes('ycn-redirect.com'))

assert.ok(mpingo.length > 0, 'expected Mpingo channels')
assert.ok(ycn.length > 0, 'expected YCN channels')

const results = { api: API, verified_at: new Date().toISOString(), mpingo: [], ycn: [], ok: true }

for (const ch of mpingo.slice(0, 3)) {
  const entry = {
    id: ch.id,
    name: ch.name,
    playerType: ch.playerType,
    playbackUrl: ch.playbackUrl,
    proxy_fallback_url: ch.proxy_fallback_url ?? null,
  }
  try {
    if (ch.playerType === 'webview') {
      assert.equal(ch.playbackUrl, ch.url, `webview ${ch.id} playbackUrl must be upstream url`)
      assert.equal(ch.stream_delivery_effective, 'upstream', `webview ${ch.id} effective routing`)
    }
    const proxyProbeUrl = ch.direct_stream_url || ch.playbackUrl
    const r = await fetch(proxyProbeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile' },
    })
    const body = await r.text()
    const baseMatch = body.match(/<base href="([^"]+)"[^>]*data-osmani-mpingo-base="1"/i)
    Object.assign(entry, {
      status: r.status,
      has_base_tag: Boolean(baseMatch),
      base_href: baseMatch?.[1] || null,
      subscriptions_resolves_to: baseMatch
        ? new URL('subscriptions.php?expired=1', baseMatch[1]).href
        : null,
      assets_resolves_to: baseMatch ? new URL('assets/js/offline.js', baseMatch[1]).href : null,
    })
    assert.equal(r.status, 200, `channel ${ch.id} status`)
    assert.ok(baseMatch, `channel ${ch.id} missing Mpingo base tag on stream-direct`)
    assert.equal(entry.base_href, 'https://nur.mpingotv.com/v3/', `channel ${ch.id} base href`)
    assert.equal(
      entry.subscriptions_resolves_to,
      'https://nur.mpingotv.com/v3/subscriptions.php?expired=1',
      `channel ${ch.id} subscriptions resolution`,
    )
  } catch (e) {
    results.ok = false
    entry.error = String(e.message || e)
  }
  results.mpingo.push(entry)
}

for (const ch of ycn.slice(0, 2)) {
  const r = await fetch(ch.playbackUrl, {
    headers: {
      Accept: 'application/vnd.apple.mpegurl,*/*',
      'User-Agent': 'ExoPlayerLib/2.19.1',
    },
  })
  const body = await r.text()
  const entry = {
    id: ch.id,
    name: ch.name,
    status: r.status,
    extm3u: body.trimStart().startsWith('#EXTM3U'),
    has_mpingo_base: body.includes('data-osmani-mpingo-base'),
  }
  try {
    assert.equal(r.status, 200, `ycn ${ch.id} status`)
    assert.equal(entry.extm3u, true, `ycn ${ch.id} must remain HLS manifest`)
    assert.equal(entry.has_mpingo_base, false, `ycn ${ch.id} must not get Mpingo base tag`)
  } catch (e) {
    results.ok = false
    entry.error = String(e.message || e)
  }
  results.ycn.push(entry)
}

console.log(JSON.stringify(results, null, 2))
if (!results.ok) process.exit(1)
console.log('verify-mpingo-html-base-live: OK')
