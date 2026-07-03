#!/usr/bin/env node
/**
 * Verify payment activation latency + deployment parity (VPS + Render API).
 *
 *   node server/scripts/verify-payment-activation-latency.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const EXPECT_COMMIT_PREFIX = String(process.env.EXPECT_COMMIT || '').trim()
const MAX_MEDIAN_SEC = Number(process.env.PAYMENT_ACTIVATION_MAX_MEDIAN_SEC || 2)

const report = { time: new Date().toISOString(), pass: true, apis: {} }

function fail(section, msg) {
  report.pass = false
  console.error(`FAIL [${section}]`, msg)
}

function pass(section, msg) {
  console.log(`PASS [${section}]`, msg)
}

async function jsonFetch(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function verifyApi(label, base) {
  const out = { base, commit: null, stats: null, verifyMs: null }
  const health = await jsonFetch(base, '/api/health')
  out.commit = health.body?.commit || null
  const commitShort = String(out.commit || 'unknown').slice(0, 12)
  console.log(`\n[${label}] commit: ${commitShort}`)
  if (!health.res.ok) {
    fail(`${label}-health`, `HTTP ${health.res.status}`)
    return out
  }
  pass(`${label}-health`, 'reachable')
  if (EXPECT_COMMIT_PREFIX && !String(out.commit || '').startsWith(EXPECT_COMMIT_PREFIX)) {
    fail(`${label}-commit`, `expected ${EXPECT_COMMIT_PREFIX}, got ${commitShort}`)
  } else if (EXPECT_COMMIT_PREFIX) {
    pass(`${label}-commit`, commitShort)
  }

  const stats = await jsonFetch(base, '/api/runtime/payment-activation-stats', {
    headers: { 'X-Admin-Token': TOKEN },
  })
  out.stats = stats.body
  if (!stats.res.ok || stats.body?.ok !== true) {
    fail(`${label}-stats`, `HTTP ${stats.res.status}`)
  } else {
    const medianCheckout = Number(
      stats.body.payment_activation_median_seconds ||
        stats.body.checkout_to_complete_median_seconds ||
        0,
    )
    const medianServer = Number(stats.body.server_activation_median_seconds || 0)
    const count = Number(stats.body.completed_count || 0)
    pass(
      `${label}-stats`,
      `n=${count} checkout_median=${medianCheckout.toFixed(2)}s server_median=${medianServer.toFixed(2)}s`,
    )
    if (count > 0 && medianServer > MAX_MEDIAN_SEC) {
      fail(`${label}-median`, `server median ${medianServer.toFixed(2)}s > ${MAX_MEDIAN_SEC}s target`)
    } else if (count > 0) {
      pass(`${label}-median`, `server pipeline <= ${MAX_MEDIAN_SEC}s`)
    }
  }

  const probe = `latency-probe-${Date.now()}`
  const t0 = performance.now()
  const verify = await jsonFetch(
    base,
    `/api/subscription-status?device_id=${encodeURIComponent(probe)}`,
  )
  out.verifyMs = Math.round(performance.now() - t0)
  if (!verify.res.ok) {
    fail(`${label}-verify`, `HTTP ${verify.res.status}`)
  } else if (out.verifyMs > 2000) {
    fail(`${label}-verify`, `${out.verifyMs}ms > 2000ms`)
  } else {
    pass(`${label}-verify`, `${out.verifyMs}ms subscription-status cold path`)
  }

  return out
}

async function main() {
  console.log('=== Payment activation latency verification ===')
  report.apis.vps = await verifyApi('VPS', VPS)
  report.apis.render = await verifyApi('Render', RENDER)

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
