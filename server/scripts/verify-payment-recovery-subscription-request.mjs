#!/usr/bin/env node
/**
 * Live verification: payment recovery + subscription request systems.
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const PIN = String(process.env.ADMIN_PIN || '3030').trim()

let failed = 0
function fail(m) {
  console.error('FAIL', m)
  failed++
}
function ok(m) {
  console.log('OK', m)
}

async function admin(path, opts = {}) {
  const res = await fetch(`${VPS}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN, ...(opts.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function verify(deviceId) {
  const res = await fetch(`${VPS}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
  return res.json()
}

async function main() {
  console.log('\n=== Payment Recovery + Subscription Request Verification ===\n')
  const health = await fetch(`${VPS}/api/health`).then((r) => r.json())
  ok(`health commit=${health.commit}`)

  const settings = await fetch(`${VPS}/api/subscription-request/settings`).then((r) => r.json())
  ok(`omba settings enabled=${settings.omba_kifurushi_enabled}`)

  const deviceA = `verify_recovery_${Date.now()}`
  const plans = await admin('/api/plans')
  const plan = (Array.isArray(plans.body) ? plans.body : []).find((p) => p.durationDays > 0 || p.duration_days > 0)
  if (!plan) fail('no plans')
  else ok(`plan ${plan.name}`)

  // TEST B — subscription request
  const t0 = Date.now()
  const subRes = await fetch(`${VPS}/api/subscription-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceA,
      phone: '+255712345678',
      plan_id: plan.id,
    }),
  })
  const subBody = await subRes.json()
  if (subRes.status !== 201 || !subBody.requestId) fail(`create request HTTP ${subRes.status}`)
  else ok(`TEST B T0 request created id=${subBody.requestId} ms=${Date.now() - t0}`)

  const dup = await fetch(`${VPS}/api/subscription-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceA, phone: '+255712345678', plan_id: plan.id }),
  })
  if (dup.status !== 409) fail(`duplicate protection expected 409 got ${dup.status}`)
  else ok('duplicate request blocked')

  const approve = await admin(`/api/admin/subscription-requests/${subBody.requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ pin: PIN, confirm: true }),
  })
  if (approve.status !== 200 || !approve.body?.grant?.grantId) fail(`approve HTTP ${approve.status}`)
  else ok(`TEST B approve grantId=${approve.body.grant.grantId}`)

  const v1 = await verify(deviceA)
  if (!v1.active || !v1.playbackAllowed) fail('verify not active after request approve')
  else ok(`verify active=true playback=${v1.playbackAllowed} gift=${!!v1.manualGift?.showPopup}`)

  // TEST C — disable feature
  await admin('/api/admin/subscription-requests/settings', {
    method: 'PUT',
    body: JSON.stringify({ pin: PIN, enabled: false }),
  })
  const disabled = await fetch(`${VPS}/api/subscription-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: `verify_disabled_${Date.now()}`,
      phone: '+255712345679',
      plan_id: plan.id,
    }),
  })
  const disBody = await disabled.json()
  if (disabled.status !== 403) fail(`disabled expected 403 got ${disabled.status}`)
  else ok(`TEST C disabled message present=${String(disBody.error || '').includes('imezuiliwa')}`)

  await admin('/api/admin/subscription-requests/settings', {
    method: 'PUT',
    body: JSON.stringify({ pin: PIN, enabled: true }),
  })
  ok('re-enabled omba kifurushi')

  // TEST A — payment recovery (create pending txn via internal test if exists, else skip)
  const orders = await admin('/api/admin/payment-orders?limit=5')
  if (orders.body?.rows?.length) ok(`payment orders ledger rows=${orders.body.rows.length}`)
  else ok('payment orders ledger empty (no attempts yet)')

  const pending = (orders.body?.rows ?? []).find(
    (r) => r.ledgerStatus === 'PENDING' && r.deviceId && r.planId && !r.manualRecoveryUsed,
  )
  if (pending) {
    const tA0 = Date.now()
    const rec = await admin(`/api/admin/payment-orders/${encodeURIComponent(pending.orderId)}/approve-recovery`, {
      method: 'POST',
      body: JSON.stringify({ pin: PIN, confirm: true }),
    })
    if (rec.status !== 200) fail(`recovery approve ${rec.status}`)
    else ok(`TEST A recovery ms=${Date.now() - tA0} idempotent=${rec.body?.idempotent}`)
    const rec2 = await admin(`/api/admin/payment-orders/${encodeURIComponent(pending.orderId)}/approve-recovery`, {
      method: 'POST',
      body: JSON.stringify({ pin: PIN, confirm: true }),
    })
    if (!rec2.body?.alreadyApproved && !rec2.body?.idempotent) fail('idempotency not proven')
    else ok('TEST A idempotent double approve')
  } else {
    ok('TEST A skipped — no eligible pending order in ledger (create payment attempt to test)')
  }

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
