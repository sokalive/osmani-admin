#!/usr/bin/env node
/**
 * Production payment pipeline verification (read-only + optional phone search).
 *
 *   node server/scripts/verify-payment-production.mjs
 *   INVESTIGATE_PHONE=0625884695 node server/scripts/verify-payment-production.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const PHONE = String(process.env.INVESTIGATE_PHONE || '0625884695').trim()
const EXPECT = String(process.env.EXPECT_COMMIT || '').trim()

const report = { time: new Date().toISOString(), pass: true, phone: PHONE, apis: {} }

function fail(k, m) {
  report.pass = false
  console.error(`FAIL [${k}]`, m)
}
function pass(k, m) {
  console.log(`PASS [${k}]`, m)
}

async function jfetch(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => null) }
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

  const inv = await jfetch(
    base,
    `/api/admin/customer-investigation/investigate?phone=${encodeURIComponent(PHONE)}`,
    { headers: { 'X-Admin-Token': TOKEN } },
  )
  out.investigate = inv.body
  const payCount =
    (inv.body?.payments?.completed?.length ?? 0) +
    (inv.body?.payments?.pending?.length ?? 0) +
    (inv.body?.payments?.failed?.length ?? 0)
  out.investigatePayments = payCount
  out.investigateDevices = inv.body?.customer?.matched_device_count ?? 0

  const users = await jfetch(
    base,
    `/api/users/?search=${encodeURIComponent(PHONE)}&limit=5&page=1`,
    { headers: { 'X-Admin-Token': TOKEN } },
  )
  out.usersTotal = users.body?.pagination?.total ?? 0

  const sms = await jfetch(
    base,
    `/api/admin/sms/log?search=${encodeURIComponent(PHONE.replace(/^0/, '255').replace(/^255/, '255'))}&limit=5`,
    { headers: { 'X-Admin-Token': TOKEN } },
  )
  out.smsTotal = sms.body?.total ?? 0
  out.smsPaymentSuccess = (sms.body?.rows || []).filter((r) => r.triggerType === 'payment_success').length

  const t0 = performance.now()
  const verify = await jfetch(base, `/api/subscription-status?device_id=probe-${Date.now()}`)
  out.verifyMs = Math.round(performance.now() - t0)

  pass(
    `${label}-search`,
    `investigate=${payCount} payments, users=${out.usersTotal}, sms=${out.smsTotal}, verify=${out.verifyMs}ms`,
  )
  return out
}

async function main() {
  console.log('=== Payment production verification ===')
  console.log('Phone:', PHONE)
  report.apis.vps = await verifyApi('VPS', VPS)
  report.apis.render = await verifyApi('Render', RENDER)
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
