#!/usr/bin/env node
/**
 * VPS + Render payment pipeline parity (commits, create-order latency, guard, providers).
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const EXPECT = String(process.env.EXPECT_COMMIT || '').trim()
const TARGET_MS = Number(process.env.CREATE_ORDER_TARGET_MS || 2500)

const report = { time: new Date().toISOString(), pass: true, apis: {} }

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
  return { status: res.status, ms: Math.round(performance.now() - t0), body: await res.json().catch(() => null) }
}

async function auditApi(label, base) {
  const out = {}
  const health = await jfetch(base, '/api/health')
  out.commit = health.body?.commit || null
  console.log(`\n[${label}] ${String(out.commit || '').slice(0, 12)}`)
  if (!health.status || health.status >= 500) {
    fail(`${label}-health`, `HTTP ${health.status}`)
    return out
  }
  pass(`${label}-health`, 'ok')

  const cp = await jfetch(base, '/api/payments/checkout-providers')
  out.providers = cp.body
  pass(`${label}-checkout-providers`, `provider=${cp.body?.payment_provider} zenopay=${cp.body?.zenopay} sonicpesa=${cp.body?.sonicpesa} auraxpay=${cp.body?.auraxpay}`)

  const probe = `parity-probe-${Date.now().toString(36)}`
  const plans = await jfetch(base, '/api/plans')
  const planId = plans.body?.plans?.[0]?.id ?? 1
  const create = await jfetch(base, '/api/payments/create-payment', {
    method: 'POST',
    body: JSON.stringify({ deviceId: probe, phone: '255700000002', planId }),
  })
  out.createMs = create.ms
  out.createStatus = create.status
  out.providerInitiation = create.body?.provider_initiation
  if (create.status === 201 && create.ms <= TARGET_MS) {
    pass(`${label}-create-payment`, `${create.ms}ms 201 initiation=${out.providerInitiation}`)
    out.orderId = create.body?.orderId
  } else if (create.status === 409) {
    pass(`${label}-create-payment`, `${create.ms}ms 409 guard`)
  } else {
    fail(`${label}-create-payment`, `HTTP ${create.status} ${create.ms}ms`)
  }

  if (out.orderId) {
    const ps = await jfetch(base, `/api/payment-status/${encodeURIComponent(out.orderId)}`)
    out.paymentStatus = ps.body?.status
    pass(`${label}-payment-status`, String(out.paymentStatus || ps.status))
  }

  const verify = await jfetch(base, `/api/subscription-status?device_id=${encodeURIComponent(probe)}`)
  out.verifyMs = verify.ms
  pass(`${label}-subscription-status`, `${verify.ms}ms`)

  report.apis[label.toLowerCase()] = out
  return out
}

const vps = await auditApi('VPS', VPS)
const render = await auditApi('Render', RENDER)

if (vps.commit && render.commit && vps.commit !== render.commit) {
  fail('commit-parity', `VPS ${String(vps.commit).slice(0, 12)} != Render ${String(render.commit).slice(0, 12)}`)
} else if (vps.commit && render.commit) {
  pass('commit-parity', String(vps.commit).slice(0, 12))
}

if (EXPECT) {
  for (const [label, out] of [
    ['VPS', vps],
    ['Render', render],
  ]) {
    if (!String(out.commit || '').startsWith(EXPECT)) {
      fail(`${label}-expect-commit`, `want ${EXPECT}`)
    }
  }
}

console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(report, null, 2))
process.exit(report.pass ? 0 : 1)
