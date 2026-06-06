/**
 * Live verify Mpingo ClearKey channels stay webview; Widevine-only channels get chrome playerType.
 * Usage: node scripts/verify-mpingo-chrome-routing-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

const r = await fetch(`${API}/api/channels`)
assert.equal(r.ok, true, `GET /api/channels ${r.status}`)
const channels = await r.json()
const list = Array.isArray(channels) ? channels : channels.channels || []

const mpingo = list.filter((c) => /mpingotv\.com/i.test(c.url || ''))
const byUrl = new Map()
for (const ch of mpingo) {
  const key = ch.url
  if (!byUrl.has(key)) byUrl.set(key, [])
  byUrl.get(key).push(ch)
}

const report = {
  api: API,
  verified_at: new Date().toISOString(),
  commit: r.headers.get('x-api-commit') || null,
  channels: mpingo.map((c) => ({
    id: c.id,
    name: c.name,
    url: c.url,
    playerType: c.playerType,
    player_type_configured: c.player_type_configured,
    playback_source: c.playback_source,
    mpingo_drm: c.mpingo_drm,
  })),
}

for (const ch of mpingo) {
  assert.ok(ch.playbackUrl, `channel ${ch.id} playbackUrl`)
  if (ch.url?.includes('channel=1') || ch.url?.includes('channel=3')) {
    assert.equal(ch.playerType, 'webview', `ClearKey channel ${ch.id} must stay webview`)
    assert.equal(ch.playback_source, 'upstream', `ClearKey channel ${ch.id} playback_source`)
  }
  if (ch.url?.includes('channel=2') || ch.url?.includes('channel=4') || ch.url?.includes('channel=7')) {
    assert.equal(ch.playerType, 'chrome', `Widevine channel ${ch.id} must be chrome`)
    assert.equal(ch.playback_source, 'mpingo_chrome_widevine', `Widevine channel ${ch.id} source`)
    assert.equal(ch.mpingo_drm?.has_clear_key, false, `Widevine channel ${ch.id} no clear key`)
  }
}

report.ok = true
console.log(JSON.stringify(report, null, 2))
console.log('verify-mpingo-chrome-routing-live: OK')
