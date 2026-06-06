/**
 * Live verification for Mpingo authorizedPackageName on /api/channels.
 * Usage: node scripts/verify-channels-authorized-package-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)

const health = await fetch(`${API}/api/health`).then((r) => r.json())
const channels = await fetch(`${API}/api/channels`).then((r) => r.json())

assert.ok(Array.isArray(channels) && channels.length > 0, 'channels list empty')

const report = {
  api: API,
  commit: health.commit,
  verified_at: new Date().toISOString(),
  channel_count: channels.length,
  with_package_name: 0,
  samples: [],
  routing_preserved: [],
  ok: true,
}

for (const c of channels) {
  try {
    assert.ok('authorizedPackageName' in c, `channel ${c.id} missing authorizedPackageName`)
    assert.ok('authorized_package_name' in c, `channel ${c.id} missing authorized_package_name`)
    assert.equal(
      c.authorizedPackageName,
      c.authorized_package_name,
      `channel ${c.id} camel/snake mismatch`,
    )
    if (String(c.authorizedPackageName || '').trim()) report.with_package_name += 1

    const isMpingoWebview =
      c.playerType === 'webview' && String(c.url || '').includes('mpingotv.com')
    const isYcnExo = c.playerType === 'exo' && String(c.url || '').includes('ycn-redirect.com')
    if (isMpingoWebview) {
      assert.equal(c.playbackUrl, c.url, `webview mpingo ${c.id} playbackUrl preserved`)
      assert.equal(c.stream_delivery_effective, 'upstream', `webview mpingo ${c.id} routing`)
    }
    if (isYcnExo) {
      assert.ok(c.playbackUrl.includes('/stream-direct'), `ycn exo ${c.id} direct playback`)
      assert.equal(c.stream_delivery_effective, 'direct', `ycn exo ${c.id} routing`)
    }

    if (report.samples.length < 3) {
      report.samples.push({
        id: c.id,
        name: c.name,
        playerType: c.playerType,
        authorizedPackageName: c.authorizedPackageName,
        playbackUrl: c.playbackUrl?.slice(0, 80),
        stream_delivery_effective: c.stream_delivery_effective,
      })
    }
    if (isMpingoWebview || isYcnExo) {
      report.routing_preserved.push({ id: c.id, playerType: c.playerType, ok: true })
    }
  } catch (e) {
    report.ok = false
    report.samples.push({ id: c.id, error: String(e.message || e) })
  }
}

console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)
console.log('verify-channels-authorized-package-live: OK')
