#!/usr/bin/env node
/**
 * 30-minute repeated verify watch — proves suppress_expiry_popup stays true.
 *   node server/scripts/watch-expiry-popup-suppress.mjs
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const DURATION_MS = Number(process.env.WATCH_MS || 30 * 60 * 1000)
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60_000)
const devices = [
  'cap67_inactive_probe_xyz',
  '85970ee4273c6ca8',
  '16b34680-0c9a-405c-882d-62f37e66c140',
]

async function verify(deviceId) {
  const res = await fetch(`${API}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  return {
    deviceId,
    http: res.status,
    active: body.active === true,
    status: body.status ?? null,
    suppress_expiry_popup: body.suppress_expiry_popup === true,
    expiry_popup_policy: body.expiry_popup_policy ?? null,
    authoritativeInactive: body.authoritativeInactive === true,
    inactive_reason: body.inactive_reason ?? null,
    playbackAllowed: body.playbackAllowed === true,
  }
}

async function sseSnapshot(deviceId) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(`${API}/api/subscription-stream?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { Accept: 'text/event-stream' },
      signal: ac.signal,
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const m = buf.match(/event: snapshot\ndata: ([^\n]+)/)
      if (m) {
        const p = JSON.parse(m[1])
        return {
          suppress_expiry_popup: p.suppress_expiry_popup === true,
          expiry_popup_policy: p.expiry_popup_policy ?? null,
          active: p.active === true,
        }
      }
    }
    return { error: 'no_snapshot' }
  } finally {
    clearTimeout(t)
    try {
      ac.abort()
    } catch {}
  }
}

const started = Date.now()
const failures = []
let rounds = 0
console.log(JSON.stringify({ watch_start: new Date().toISOString(), api: API, duration_ms: DURATION_MS }))

while (Date.now() - started < DURATION_MS) {
  rounds += 1
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const results = []
  for (const d of devices) {
    const v = await verify(d)
    results.push(v)
    if (!v.suppress_expiry_popup || v.expiry_popup_policy !== 'never') {
      failures.push({ at: new Date().toISOString(), type: 'verify', ...v })
    }
  }
  const sse = await sseSnapshot(devices[0])
  if (sse.suppress_expiry_popup !== true || sse.expiry_popup_policy !== 'never') {
    failures.push({ at: new Date().toISOString(), type: 'sse', ...sse })
  }
  console.log(
    JSON.stringify({
      round: rounds,
      elapsed_min: Number(((Date.now() - started) / 60000).toFixed(2)),
      commit: String(health.commit || '').slice(0, 12),
      ok: health.ok === true,
      results,
      sse,
      failure_count: failures.length,
    }),
  )
  if (Date.now() - started + INTERVAL_MS >= DURATION_MS) break
  await new Promise((r) => setTimeout(r, INTERVAL_MS))
}

const report = {
  watch_end: new Date().toISOString(),
  rounds,
  duration_min: Number(((Date.now() - started) / 60000).toFixed(2)),
  failure_count: failures.length,
  failures,
  popup_free: failures.length === 0,
}
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length ? 1 : 0)
