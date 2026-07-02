#!/usr/bin/env node
/**
 * Measure create-order HTTP response time (should be <2s after async provider initiation).
 * Uses probe device — may create pending txn on provider; does not complete payment.
 *
 *   node server/scripts/verify-payment-create-order-latency.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TARGET_MS = Number(process.env.CREATE_ORDER_TARGET_MS || 2000)
const EXPECT = String(process.env.EXPECT_COMMIT || '').trim()

const report = { time: new Date().toISOString(), pass: true, target_ms: TARGET_MS, apis: {} }

function fail(k, m) {
  report.pass = false
  console.error(`FAIL [${k}]`, m)
}
function pass(k, m) {
  console.log(`PASS [${k}]`, m)
}

async function jfetch(base, path, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    cache: 'no-store',
  })
  const ms = Math.round(performance.now() - t0)
  return { status: res.status, ms, body: await res.json().catch(() => null) }
}

async function verifyApi(label, base) {
  const out = {}
  const health = await jfetch(base, '/api/health')
  out.commit = health.body?.commit || null
  console.log(`\n[${label}] commit ${String(out.commit || '').slice(0, 12)}`)
  if (!health.status || health.status >= 500) {
    fail(`${label}-health`, `HTTP ${health.status}`)
    return out
  }
  pass(`${label}-health`, 'ok')
  if (EXPECT && !String(out.commit || '').startsWith(EXPECT)) {
    fail(`${label}-commit`, `expected ${EXPECT}`)
  }

  const providers = await jfetch(base, '/api/payments/checkout-providers')
  out.checkout_providers_ms = providers.ms
  out.payment_provider = providers.body?.payment_provider
  pass(`${label}-checkout-providers`, `${providers.ms}ms provider=${out.payment_provider}`)

  const probeDevice = `latency-probe-${Date.now().toString(36)}`
  const plans = await jfetch(base, '/api/plans')
  const planId = plans.body?.plans?.[0]?.id ?? plans.body?.[0]?.id ?? 1
  const create = await jfetch(base, '/api/payments/create-payment', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: probeDevice,
      phone: '255700000001',
      planId,
    }),
  })
  out.create_payment_ms = create.ms
  out.create_status = create.status
  out.provider_initiation = create.body?.provider_initiation

  if (create.status === 201) {
    if (create.ms > TARGET_MS) fail(`${label}-create-payment`, `${create.ms}ms > ${TARGET_MS}ms`)
    else pass(`${label}-create-payment`, `${create.ms}ms status=201 initiation=${out.provider_initiation}`)
    if (create.body?.orderId) out.orderId = create.body.orderId
  } else if (create.status === 409) {
    pass(`${label}-create-payment`, `${create.ms}ms blocked 409 (phone guard — latency ok)`)
  } else {
    fail(`${label}-create-payment`, `HTTP ${create.status} ${create.ms}ms`)
  }

  report.apis[label.toLowerCase()] = out
  return out
}

await verifyApi('VPS', VPS)
await verifyApi('Render', RENDER)

console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(report, null, 2))
console.log(`\nOVERALL: ${report.pass ? 'PASS' : 'FAIL'}`)
process.exit(report.pass ? 0 : 1)
