/**
 * Live audit: channel playback URLs must not use Bunny CDN for stream-direct/stream-proxy.
 * Usage: node scripts/verify-stream-url-hosts-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const BUNNY = /b-cdn\.net/i
const STREAM_PATH = /\/stream-(direct|proxy)/i

const FIELDS = [
  'playbackUrl',
  'direct_stream_url',
  'proxy_playback_url',
  'proxy_fallback_url',
  'backupPlayback1',
  'backupPlayback2',
  'direct_stream_url_backup1',
  'direct_stream_url_backup2',
]

function walkStreamUrls(obj, prefix = '', out = []) {
  if (obj == null) return out
  if (typeof obj === 'string') {
    if (STREAM_PATH.test(obj)) out.push({ path: prefix, url: obj })
    return out
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkStreamUrls(v, `${prefix}[${i}]`, out))
    return out
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      walkStreamUrls(v, prefix ? `${prefix}.${k}` : k, out)
    }
  }
  return out
}

const health = await fetch(`${API}/api/health`).then((r) => r.json())
const r = await fetch(`${API}/api/channels`)
assert.equal(r.ok, true)
const list = await r.json()

const violations = []
const samples = []

for (const ch of list) {
  const urls = walkStreamUrls(ch)
  for (const entry of urls) {
    samples.push({ id: ch.id, name: ch.name, ...entry })
    if (BUNNY.test(entry.url)) violations.push({ id: ch.id, name: ch.name, ...entry })
  }
}

const report = {
  api: API,
  verified_at: new Date().toISOString(),
  production_commit: health.commit || null,
  channel_count: list.length,
  stream_url_count: samples.length,
  bunny_stream_violations: violations.length,
  violations,
  hosts: [...new Set(samples.map((s) => {
    try { return new URL(s.url).host } catch { return 'invalid' }
  }))],
}

assert.equal(violations.length, 0, `Bunny stream-direct/proxy URLs found: ${JSON.stringify(violations)}`)
console.log(JSON.stringify(report, null, 2))
console.log('verify-stream-url-hosts-live: OK')
