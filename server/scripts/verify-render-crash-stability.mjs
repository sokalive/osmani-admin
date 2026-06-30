#!/usr/bin/env node
/**
 * Render crash-loop probe: uptime must increase, health must stay JSON, no 502 bursts.
 *
 * Usage:
 *   node scripts/verify-render-crash-stability.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com WATCH_MINUTES=30 node scripts/verify-render-crash-stability.mjs
 */
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(
  /\/+$/,
  '',
)
const WATCH_MINUTES = Math.max(1, Math.min(60, Number(process.env.WATCH_MINUTES) || 5))
const INTERVAL_SEC = Math.max(10, Number(process.env.WATCH_INTERVAL_SEC) || 30)
const PROBE = `render_crash_probe_${Date.now()}`

let failed = 0
let lastUptime = -1
let restarts = 0
let samples = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${RENDER}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  let parseError = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    parseError = e.message
  }
  return { status: res.status, body, parseError, text: text.slice(0, 160) }
}

async function sampleOnce(label) {
  const health = await fetchJson('/api/health')
  samples += 1
  if (health.status >= 500 || health.parseError) {
    fail(`${label} health HTTP/JSON status=${health.status} err=${health.parseError || health.text}`)
    return
  }
  const uptime = Number(health.body?.startup?.uptime_sec ?? health.body?.uptime_sec ?? -1)
  if (uptime >= 0 && lastUptime >= 0 && uptime + 15 < lastUptime) {
    restarts += 1
    fail(`${label} uptime dropped ${lastUptime}s → ${uptime}s (restart #${restarts})`)
  } else if (uptime >= 0) {
    ok(`${label} uptime=${uptime}s commit=${String(health.body?.commit || '').slice(0, 7)} startup.ready=${health.body?.startup?.ready}`)
    lastUptime = uptime
  }

  const burst = await Promise.all([
    fetchJson('/api/update-check?version_code=20'),
    fetchJson(`/api/subscription-status?device_id=${encodeURIComponent(PROBE)}`),
    fetchJson('/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: PROBE, fingerprint: 'crash-stability' }),
    }),
  ])
  const bad = burst.filter((r) => r.status >= 500 || r.parseError)
  if (bad.length) {
    fail(`${label} burst ${bad.length}/3 failed sample=${bad[0].status} ${bad[0].parseError || bad[0].text}`)
  } else {
    ok(`${label} burst 3/3 JSON ok`)
  }
}

async function main() {
  console.log(`Watching ${RENDER} for ${WATCH_MINUTES}m every ${INTERVAL_SEC}s`)
  const endAt = Date.now() + WATCH_MINUTES * 60_000
  let i = 0
  while (Date.now() < endAt) {
    i += 1
    await sampleOnce(`tick-${i}`)
    if (Date.now() < endAt) {
      await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000))
    }
  }

  const db = await fetchJson('/api/health/db')
  if (db.parseError || db.status >= 500) fail(`final health/db invalid status=${db.status}`)
  else {
    ok(
      `final db pool=${db.body?.pg?.pool?.totalCount}/${db.body?.pg?.pool?.max} waiting=${db.body?.pg?.pool?.waitingCount}`,
    )
  }

  console.log(`\nSummary: samples=${samples} restarts_detected=${restarts} failures=${failed}`)
  if (failed) process.exit(1)
  console.log('PASS Render crash stability watch')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
