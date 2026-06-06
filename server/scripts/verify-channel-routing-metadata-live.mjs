/**
 * Live audit: /api/channels routing metadata for all channels.
 * Usage: node scripts/verify-channel-routing-metadata-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)

const health = await fetch(`${API}/api/health`).then((r) => r.json())
const channels = await fetch(`${API}/api/channels`).then((r) => r.json())

const results = {
  api: API,
  commit: health.commit,
  verified_at: new Date().toISOString(),
  channel_count: channels.length,
  player_types: {},
  channels: [],
  ok: true,
}

for (const c of channels) {
  results.player_types[c.playerType] = (results.player_types[c.playerType] || 0) + 1
  const isMpingo = String(c.url || '').includes('mpingotv.com')
  const isYcn = String(c.url || '').includes('ycn-redirect.com')
  const entry = {
    id: c.id,
    name: c.name,
    playerType: c.playerType,
    provider: isMpingo ? 'mpingo' : isYcn ? 'ycn' : 'other',
    url: c.url,
    playbackUrl: c.playbackUrl,
    direct_stream_url: c.direct_stream_url || null,
    proxy_playback_url: c.proxy_playback_url || null,
    proxy_fallback_url: c.proxy_fallback_url ?? null,
    stream_delivery_effective: c.stream_delivery_effective,
    playback_source: c.playback_source ?? null,
    nested_fallback: c.streamProxy?.playbackFallbackUrl ?? null,
  }

  try {
    assert.ok(c.url, `channel ${c.id} missing url`)
    assert.ok(c.playbackUrl, `channel ${c.id} missing playbackUrl`)
    assert.ok(c.direct_stream_url, `channel ${c.id} missing direct_stream_url`)
    assert.ok(c.proxy_playback_url, `channel ${c.id} missing proxy_playback_url`)
    assert.equal(
      c.proxy_fallback_url,
      c.proxy_playback_url,
      `channel ${c.id} proxy_fallback_url must mirror proxy_playback_url`,
    )
    assert.equal(
      c.streamProxy?.playbackFallbackUrl,
      c.proxy_playback_url,
      `channel ${c.id} nested playbackFallbackUrl mismatch`,
    )

    if (c.playerType === 'webview' && isMpingo) {
      assert.equal(c.playbackUrl, c.url, `webview Mpingo ${c.id} playbackUrl must be upstream url`)
      assert.equal(c.stream_delivery_effective, 'upstream', `webview Mpingo ${c.id} effective`)
      assert.equal(c.playback_source, 'upstream', `webview Mpingo ${c.id} playback_source`)
    } else if (c.playerType === 'exo' && isYcn) {
      assert.ok(c.playbackUrl.includes('/stream-direct'), `ycn exo ${c.id} playbackUrl`)
      assert.equal(c.stream_delivery_effective, 'direct', `ycn exo ${c.id} effective`)
      const r = await fetch(c.playbackUrl, {
        headers: { Accept: '*/*', 'User-Agent': 'ExoPlayerLib/2.19.1' },
      })
      const body = await r.text()
      entry.hls_probe = { status: r.status, extm3u: body.trimStart().startsWith('#EXTM3U') }
      assert.equal(r.status, 200, `ycn ${c.id} playback status`)
      assert.equal(entry.hls_probe.extm3u, true, `ycn ${c.id} must return HLS`)
    }
  } catch (e) {
    results.ok = false
    entry.error = String(e.message || e)
  }
  results.channels.push(entry)
}

console.log(JSON.stringify(results, null, 2))
if (!results.ok) process.exit(1)
console.log('verify-channel-routing-metadata-live: OK')
