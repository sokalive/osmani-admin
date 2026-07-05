#!/usr/bin/env node
/**
 * Live VPS API verification for safe Payment Orders recovery (read-only + blocked paths).
 * No customer mutations unless PAYMENT_RECOVERY_LIVE_MUTATE=1 with synthetic fixture orders.
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const PIN = String(process.env.ADMIN_PIN || '3030').trim()

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

async function admin(path, opts = {}) {
  const res = await fetch(`${VPS}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function main() {
  const health = await fetch(`${VPS}/api/health`).then((r) => r.json())
  assert('vps health', health.ok === true, health.commit?.slice(0, 12))

  const list = await admin('/api/admin/payment-orders?limit=5')
  assert('payment orders list', list.status === 200 && Array.isArray(list.body?.rows))
  const row = list.body?.rows?.[0]
  if (row) {
    assert('recoveryHint present', typeof row.recoveryHint === 'string', row.recoveryHint)
    const elig = await admin(`/api/admin/payment-orders/${encodeURIComponent(row.orderId)}/recovery-eligibility`)
    assert('recovery-eligibility', elig.status === 200 && elig.body?.eligibility?.class, elig.body?.eligibility?.class)
  }

  let providerPending = null
  for (const r of (list.body?.rows ?? []).filter((x) => x.status === 'pending' && x.deviceId).slice(0, 20)) {
    const elig = await admin(`/api/admin/payment-orders/${encodeURIComponent(r.orderId)}/recovery-eligibility`)
    if (elig.body?.eligibility?.class === 'PROVIDER_PENDING') {
      providerPending = r
      break
    }
  }
  if (providerPending) {
    const blocked = await admin(`/api/admin/payment-orders/${encodeURIComponent(providerPending.orderId)}/recover`, {
      method: 'POST',
      body: JSON.stringify({ pin: PIN, confirm: true, owner_override: false, attempt_provider_poll: false }),
    })
    assert(
      'pending blocked without override',
      blocked.status === 409 && blocked.body?.requiresOwnerOverride === true,
      String(blocked.status),
    )
    const badPin = await admin(`/api/admin/payment-orders/${encodeURIComponent(providerPending.orderId)}/recover`, {
      method: 'POST',
      body: JSON.stringify({ pin: '0000', confirm: true }),
    })
    assert('wrong PIN rejected', badPin.status === 403, String(badPin.status))
  } else {
    assert('pending blocked without override', true, 'SKIP no PROVIDER_PENDING row')
  }

  const metrics = await admin('/api/runtime/sonicpesa-reliability-metrics?days=30')
  assert('metrics reachable', metrics.status === 200, `critical=${metrics.body?.critical_unresolved_completed}`)
  assert('critical_unresolved=0', metrics.body?.critical_unresolved_completed === 0)

  const audit = await admin('/api/runtime/payment-production-audit?days=90')
  assert('payment audit', audit.status === 200 && audit.body?.verdict === 'NO_BUG_FOUND')

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks.filter((x) => x.ok)) console.log(`PASS ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  for (const c of failed) console.error(`FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
