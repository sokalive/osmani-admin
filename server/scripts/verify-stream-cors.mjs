/**
 * Production check: stream routes accept APK-like Origin headers; /api stays protected.
 */
import assert from 'node:assert/strict'

const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

const exo = {
  'User-Agent': 'ExoPlayerLib/2.19.1 (Linux;Android 13) ExoPlayer',
  Accept: 'application/vnd.apple.mpegurl,*/*',
}

const apkOrigins = [null, 'null', 'exp://127.0.0.1:8081', 'http://localhost:8081']

const ch = await fetch(`${API}/api/channels`).then((r) => r.json())
const bein = ch.find((c) => c.id === 16)
assert.ok(bein?.playbackUrl, 'Bein channel 16 missing')

for (const origin of apkOrigins) {
  const headers = { ...exo }
  if (origin != null) headers.Origin = origin
  const r = await fetch(bein.playbackUrl, { headers })
  const t = await r.text()
  assert.equal(r.status, 200, `stream-direct status for origin=${origin}: ${t.slice(0, 80)}`)
  assert.ok(t.startsWith('#EXTM3U'), `expected m3u8 for origin=${origin}`)
}

const blocked = await fetch(`${API}/api/channels`, {
  headers: { Origin: 'https://evil.example.com' },
})
assert.equal(blocked.status, 500, 'admin API should reject unknown Origin')

console.log('verify-stream-cors: OK')
