/**
 * Execute telemetry-aware directed migrations from before-audit pairs.
 * Requires POST /api/runtime/subscription-shadow-migrate on API (after deploy).
 * Fallback: probes and prints curl commands.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'

function curlJson(url, opts = {}) {
  const parts = [`curl.exe`, `--max-time`, `60`, `-s`]
  if (opts.method === 'POST') parts.push('-X', 'POST')
  parts.push('-H', `X-Admin-Token: ${TOKEN}`)
  parts.push('-H', `Content-Type: application/json`)
  if (opts.body) parts.push('--data-raw', JSON.stringify(opts.body))
  parts.push(`"${url}"`)
  const raw = execSync(parts.join(' '), { encoding: 'utf8', shell: true })
  return JSON.parse(raw)
}

function status(deviceId) {
  const b = curlJson(`${API}/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`)
  return b.active === true && b.playbackAllowed === true
}

const before = JSON.parse(readFileSync(new URL('../../tmp-before-audit.json', import.meta.url)))
const host = before.host_attribution || {}
const pairKey = (a, b) => [a, b].sort().join('|')
const pairs = new Map()
for (const row of before.before.revoked_shadow_devices || []) {
  const a = String(row.device_id || '').trim()
  const b = String(row.source_device_id || '').trim()
  if (!a || !b) continue
  const key = pairKey(a, b)
  if (!pairs.has(key)) {
    const target = host[a] && !host[b] ? a : host[b] && !host[a] ? b : a.length >= b.length ? a : b
    pairs.set(key, { target, source: target === a ? b : a })
  }
}

const results = []
for (const { target, source } of pairs.values()) {
  if (status(target)) {
    results.push({ target, source, ok: true, skipped: 'already_active' })
    continue
  }
  if (!status(source)) {
    results.push({ target, source, ok: false, error: 'source_not_active' })
    continue
  }
  try {
    const r = curlJson(`${API}/api/runtime/subscription-shadow-migrate`, {
      method: 'POST',
      body: { target_device_id: target, source_device_id: source },
    })
    results.push({ target, source, ...r })
  } catch (e) {
    results.push({ target, source, ok: false, error: String(e.message || e), hint: 'deploy subscription-shadow-migrate endpoint' })
  }
}

const bad = results.filter((r) => !r.ok && !r.skipped)
console.log(JSON.stringify({ pairs: pairs.size, ok: results.filter((r) => r.ok || r.skipped).length, bad: bad.length, results }, null, 2))
process.exit(bad.length > 0 ? 1 : 0)
