#!/usr/bin/env node
/**
 * Production-safe subscription + transaction integrity audit.
 *
 *   node scripts/verify-subscription-integrity-audit.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()

const REQUIRED_VERIFY = [
  'active',
  'status',
  'expiresAt',
  'expires_at',
  'remainingDays',
  'remaining_days',
  'planName',
  'plan_name',
  'amount',
  'duration',
  'durationDays',
  'startedAt',
  'started_at',
  'activatedAt',
  'activated_at',
]

const report = { time: new Date().toISOString(), pass: true, apis: {} }

function fail(k, m) {
  report.pass = false
  console.error(`FAIL [${k}]`, m)
}
function pass(k, m) {
  console.log(`PASS [${k}]`, m)
}

async function adminGet(base, path) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function auditApi(label, base) {
  const out = {}
  const health = await fetch(`${base}/api/health`).then((r) => r.json())
  out.commit = health.commit
  console.log(`\n[${label}] ${String(out.commit || '').slice(0, 12)}`)

  const cp = await fetch(`${base}/api/payments/checkout-providers`).then((r) => r.json())
  out.checkout = {
    payment_provider: cp.payment_provider,
    sonicpesa: cp.sonicpesa,
    zenopay: cp.zenopay,
  }
  pass(`${label}-checkout`, JSON.stringify(out.checkout))

  const active = await adminGet(base, '/api/users/active?page=1&limit=10')
  const rows = active.body?.items || active.body?.rows || []
  if (rows.length === 0) {
    pass(`${label}-verify-fields`, 'no active rows to sample')
  } else {
    let sparseCount = 0
    for (const sample of rows.slice(0, 5)) {
      const deviceId = sample.device_id
      const verify = await fetch(`${base}/api/subscription/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
        cache: 'no-store',
      }).then((r) => r.json())
      const missing = REQUIRED_VERIFY.filter((k) => verify[k] === undefined)
      const sparse =
        verify.active === true &&
        (verify.amount == null || verify.planName == null || verify.duration == null)
      if (missing.length) fail(`${label}-verify-fields`, `missing ${missing.join(', ')}`)
      if (sparse) {
        sparseCount += 1
        fail(`${label}-verify-sparse`, `device=${String(deviceId).slice(0, 8)}… amount/plan/duration null`)
      }
      if (!out.verifySample) {
        out.verifySample = {
          device_id: deviceId,
          active: verify.active,
          planName: verify.planName,
          duration: verify.duration,
          amount: verify.amount,
          startedAt: verify.startedAt,
          activatedAt: verify.activatedAt,
        }
      }
    }
    if (sparseCount === 0) {
      pass(`${label}-verify-fields`, `checked ${Math.min(rows.length, 5)} active devices — full metadata`)
    }
  }

  const tx = await adminGet(base, '/api/transactions')
  const txRows = Array.isArray(tx.body) ? tx.body : []
  let spZenPairs = 0
  const byDev = new Map()
  for (const r of txRows) {
    const d = r.device_id
    if (!d) continue
    if (!byDev.has(d)) byDev.set(d, [])
    byDev.get(d).push(r)
  }
  for (const list of byDev.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const dt = Math.abs(new Date(sorted[j].created_at) - new Date(sorted[i].created_at))
        if (dt > 300000) break
        const pa = String(sorted[i].order_id || '')
        const pb = String(sorted[j].order_id || '')
        const aSp = pa.startsWith('osm_sp_')
        const bSp = pb.startsWith('osm_sp_')
        const aZm = pa.startsWith('osm_') && !pa.startsWith('osm_sp_') && !pa.startsWith('osm_ax_')
        const bZm = pb.startsWith('osm_') && !pb.startsWith('osm_sp_') && !pb.startsWith('osm_ax_')
        if ((aSp && bZm) || (aZm && bSp)) spZenPairs++
      }
    }
  }
  out.sp_zen_pairs_within_5min = spZenPairs
  pass(`${label}-duplicate-txn-audit`, `sp+zen pairs (historical)=${spZenPairs}`)

  report.apis[label.toLowerCase()] = out
  return out
}

await auditApi('VPS', VPS)
await auditApi('Render', RENDER)

const vpsC = String(report.apis.vps?.commit || '')
const renderC = String(report.apis.render?.commit || '')
if (vpsC && renderC && !vpsC.startsWith(renderC.slice(0, 7)) && !renderC.startsWith(vpsC.slice(0, 7))) {
  fail('commit-parity', `VPS ${vpsC.slice(0, 7)} != Render ${renderC.slice(0, 7)}`)
} else {
  pass('commit-parity', `${vpsC.slice(0, 7)} / ${renderC.slice(0, 7)}`)
}

console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(report, null, 2))
console.log(`\nOVERALL: ${report.pass ? 'PASS' : 'FAIL'}`)
process.exit(report.pass ? 0 : 1)
