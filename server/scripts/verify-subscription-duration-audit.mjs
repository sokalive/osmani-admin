#!/usr/bin/env node
/**
 * Production-safe subscription duration + SMS path audit (read-only on production).
 *
 *   node server/scripts/verify-subscription-duration-audit.mjs
 */
import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const PHONE = String(process.env.INVESTIGATE_PHONE || '0625884695').trim()

const report = { time: new Date().toISOString(), pass: true, local: {}, production: {} }

function fail(k, m) {
  report.pass = false
  console.error(`FAIL [${k}]`, m)
}
function pass(k, m) {
  console.log(`PASS [${k}]`, m)
}

// Local midnight-EAT expiry math (stacking disabled)
const durations = [1, 2, 3, 7, 30, 365]
const t0 = Date.UTC(2026, 6, 25, 8, 0, 0) // 25 Jul 08:00 UTC
for (const d of durations) {
  const r = computeStackedExpiryIso(null, d, t0)
  if (r.stacked !== false || r.expiry_policy !== 'midnight_africa_dar_es_salaam') {
    fail(`expiry-${d}d`, `policy ${r.expiry_policy} stacked=${r.stacked}`)
  } else {
    pass(`expiry-${d}d`, r.expiresAt)
  }
}
const activePrev = new Date(t0 + 2 * 86400000).toISOString()
const preserve = computeStackedExpiryIso(activePrev, 7, t0)
if (preserve.expiresAt === activePrev && preserve.stacked === false) {
  pass('preserve-active', preserve.expiresAt)
} else {
  fail('preserve-active', `${preserve.expiresAt} != ${activePrev}`)
}

async function jfetch(base, path) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

for (const [label, base] of [
  ['VPS', VPS],
  ['Render', RENDER],
]) {
  const out = {}
  const health = await jfetch(base, '/api/health')
  out.commit = health.body?.commit
  const plans = await jfetch(base, '/api/plans')
  out.plans = (Array.isArray(plans.body) ? plans.body : plans.body?.plans || []).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    durationDays: p.durationDays ?? p.duration_days,
  }))
  const tex = out.plans.find((p) => Number(p.price) === 1000 && Number(p.durationDays) === 2)
  if (tex) pass(`${label}-plan-tex-2d`, `id=${tex.id} ${tex.name}`)
  else fail(`${label}-plan-tex-2d`, 'missing 1000 TZS / 2 day plan')

  const audit = await jfetch(base, `/api/runtime/subscription-expiry-audit?limit=200&sinceDays=30`)
  out.audit = audit.body?.summary
  if (audit.body?.summary?.under_credited <= 1) {
    pass(`${label}-expiry-audit`, JSON.stringify(audit.body.summary))
  } else {
    fail(`${label}-expiry-audit`, `under_credited=${audit.body?.summary?.under_credited}`)
  }

  const replayRows = (audit.body?.rows || []).filter((r) => r.category === 'replay_match').slice(0, 5)
  for (const row of replayRows) {
    const lastDays = row.last_package_duration_days
    const actual = row.actual_expires_at
    const expected = row.expected_expires_at
    if (lastDays != null && actual && expected) {
      const deltaH = Math.abs(new Date(actual) - new Date(expected)) / 3600000
      if (deltaH <= 0.05) {
        pass(`${label}-plan-${lastDays}d-replay`, `device …${String(row.device_id_masked || '').slice(-4)}`)
      } else {
        fail(`${label}-plan-${lastDays}d-replay`, `delta ${deltaH.toFixed(2)}h`)
      }
    }
  }

  const inv = await jfetch(base, `/api/admin/customer-investigation/investigate?phone=${encodeURIComponent(PHONE)}`)
  out.investigate = {
    payments: (inv.body?.payments?.completed?.length ?? 0) + (inv.body?.payments?.pending?.length ?? 0),
    devices: inv.body?.customer?.matched_device_count ?? 0,
  }
  pass(`${label}-phone-${PHONE}`, `payments=${out.investigate.payments} devices=${out.investigate.devices}`)

  report.production[label.toLowerCase()] = out
}

console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(report, null, 2))
process.exit(report.pass ? 0 : 1)
