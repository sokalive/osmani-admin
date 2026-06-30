#!/usr/bin/env node
/**
 * Production load probe: subscription verify + update-check must return JSON under concurrent requests.
 *
 * Usage:
 *   node scripts/verify-render-cache-stability.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-render-cache-stability.mjs
 */
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const PROBE = `cache_stability_${Date.now()}`

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  let parseError = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    parseError = e.message
  }
  return { status: res.status, body, parseError, text: text.slice(0, 200) }
}

async function burstJson(label, base, path, count, opts = {}) {
  const tasks = Array.from({ length: count }, () => fetchJson(base, path, opts))
  const results = await Promise.all(tasks)
  const errors = results.filter((r) => r.status >= 500 || r.parseError)
  const okCount = results.length - errors.length
  if (errors.length > 0) {
    fail(`${label}: ${errors.length}/${count} failed (HTTP/JSON) sample=${errors[0].status} ${errors[0].parseError || errors[0].text}`)
  } else {
    ok(`${label}: ${okCount}/${count} JSON responses`)
  }
  return results
}

async function auditHost(name, base) {
  console.log(`\n=== ${name} (${base}) ===`)
  await burstJson(`${name} GET update-check x20`, base, '/api/update-check?version_code=20', 20)
  await burstJson(
    `${name} GET subscription-status x20`,
    base,
    `/api/subscription-status?device_id=${encodeURIComponent(PROBE)}`,
    20,
  )
  await burstJson(
    `${name} POST subscription/verify x15`,
    base,
    '/api/subscription/verify',
    15,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: PROBE, fingerprint: 'cache-stability-probe' }),
    },
  )
  await burstJson(`${name} GET runtime/app-update x10`, base, '/api/runtime/app-update?version_code=20', 10)

  const health = await fetchJson(base, '/api/health')
  if (health.parseError) fail(`${name} health invalid JSON`)
  else ok(`${name} health HTTP ${health.status}`)
}

async function main() {
  await auditHost('RENDER', RENDER)
  await auditHost('VPS', VPS)

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nCache stability probes passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
