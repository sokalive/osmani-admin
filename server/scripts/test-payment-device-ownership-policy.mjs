#!/usr/bin/env node
/**
 * Payment-bound-to-originating-device ownership policy tests (no real charges).
 * Run: node server/scripts/test-payment-device-ownership-policy.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'
import { ACTIVATION_STATE } from '../src/lib/canonicalPaymentActivation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

// --- Static policy guards (no DB) ---
const guardSrc = fs.readFileSync(path.join(__dirname, '../src/lib/phoneSubscriptionGuard.js'), 'utf8')
const activationSrc = fs.readFileSync(path.join(__dirname, '../src/lib/canonicalPaymentActivation.js'), 'utf8')

assert(
  'policy comment payment-bound',
  guardSrc.includes('Payment-bound entitlement') && guardSrc.includes('independent_device_payment'),
)
assert(
  'assess allows independent_device_payment',
  guardSrc.includes("reason: 'independent_device_payment'") && !guardSrc.includes('return buildConflictAssessment'),
)
assert(
  'activation does not mark phone conflict',
  !activationSrc.includes('markTransactionPhoneActivationConflict'),
)
assert(
  'sibling lookup uses device_transfers',
  activationSrc.includes('device_transfers dt') && !activationSrc.includes('assessPhoneSubscriptionActivation(payingDeviceId, phone)'),
)
assert(
  'device_id from txn row',
  activationSrc.includes('txn.device_id') && activationSrc.includes('upsertDeviceSubscriptionActive'),
)

// --- Stacking semantics unchanged ---
{
  const now = Date.UTC(2026, 4, 24, 12, 0, 0)
  const MS_DAY = 86400000
  const prev = new Date(now + MS_DAY).toISOString()
  const out = computeStackedExpiryIso(prev, 7, now)
  const days = (new Date(out.expiresAt).getTime() - now) / MS_DAY
  assert('same-device stack 1d+7d', out.stacked === true && Math.abs(days - 8) < 0.01, String(days))
}

async function runDbTests() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP DB ownership tests — DATABASE_URL not set')
    return
  }

  const { getPool } = await import('../src/db/pool.js')
  const billing = await import('../src/billingStore.js')
  const { activateFromCompletedTxn } = await import('../src/lib/canonicalPaymentActivation.js')
  const { assessPhoneSubscriptionActivation } = await import('../src/lib/phoneSubscriptionGuard.js')

  await billing.ensureBillingStorage()
  const pool = getPool()

  const phone = `2557${String(Date.now()).slice(-8)}`
  const deviceA = `own-test-a-${crypto.randomBytes(8).toString('hex')}`
  const deviceB = `own-test-b-${crypto.randomBytes(8).toString('hex')}`
  const planId = 3
  const plan = await billing.getPlanById(planId)
  if (!plan) {
    assert('plan exists', false, `plan ${planId}`)
    return
  }

  const orderA = `own_test_a_${Date.now()}`
  const orderB = `own_test_b_${Date.now() + 1}`
  const orderC = `own_test_c_${Date.now() + 2}`

  async function insertCompleted(orderId, deviceId) {
    await billing.insertTransaction({
      order_id: orderId,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'completed',
      device_id: deviceId,
      raw_payload: { test_fixture: true, device_id: deviceId, payment_provider: 'sonicpesa' },
    })
    return billing.getTransactionByOrderId(orderId)
  }

  try {
    // Case A: Device A pays
    const txnA = await insertCompleted(orderA, deviceA)
    const actA = await activateFromCompletedTxn(txnA, { source: 'admin_recovery' })
    assert('device A activated', actA.activated === true && actA.activation_state === ACTIVATION_STATE.ACTIVATED)
    const subA1 = await billing.getDeviceSubscriptionByDeviceId(deviceA)
    assert('device A active row', subA1?.status === 'active' && new Date(subA1.expires_at).getTime() > Date.now())

    // Probe: Device B same phone should be allowed before payment
    const probeB = await assessPhoneSubscriptionActivation(deviceB, phone)
    assert(
      'device B probe allowed',
      probeB.allowed === true && probeB.reason === 'independent_device_payment',
      probeB.reason,
    )

    // Case B: Device B pays — A must remain active
    const txnB = await insertCompleted(orderB, deviceB)
    const actB = await activateFromCompletedTxn(txnB, { source: 'admin_recovery' })
    assert('device B activated', actB.activated === true && actB.activation_state === ACTIVATION_STATE.ACTIVATED)
    const subA2 = await billing.getDeviceSubscriptionByDeviceId(deviceA)
    const subB = await billing.getDeviceSubscriptionByDeviceId(deviceB)
    assert('device A still active', subA2?.status === 'active' && new Date(subA2.expires_at).getTime() > Date.now())
    assert('device B active', subB?.status === 'active' && new Date(subB.expires_at).getTime() > Date.now())

    // Same device new order stacking (Order C on A)
    const expBefore = subA2.expires_at
    const txnC = await insertCompleted(orderC, deviceA)
    const actC = await activateFromCompletedTxn(txnC, { source: 'admin_recovery' })
    assert('device A stack activated', actC.activated === true)
    const subA3 = await billing.getDeviceSubscriptionByDeviceId(deviceA)
    assert(
      'device A expiry extended',
      new Date(subA3.expires_at).getTime() >= new Date(expBefore).getTime(),
    )

    // Duplicate callback ×10 on Order A
    let dupGrants = 0
    for (let i = 0; i < 10; i++) {
      const dup = await activateFromCompletedTxn(txnA, { source: 'sonic_webhook' })
      if (dup.activated) dupGrants++
    }
    assert('duplicate callbacks idempotent', dupGrants === 0, `grants=${dupGrants}`)

    // Pending order must not activate
    const orderPending = `own_test_p_${Date.now()}`
    await billing.insertTransaction({
      order_id: orderPending,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'pending',
      device_id: deviceB,
      raw_payload: { test_fixture: true },
    })
    const txnP = await billing.getTransactionByOrderId(orderPending)
    const actP = await activateFromCompletedTxn(txnP, { source: 'order_status_poll' })
    assert('pending not activated', actP.activated === false && actP.reason === 'not_completed')

    // Failed order must not activate
    const orderFail = `own_test_f_${Date.now()}`
    await billing.insertTransaction({
      order_id: orderFail,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'failed',
      device_id: deviceB,
      raw_payload: { test_fixture: true },
    })
    const txnF = await billing.getTransactionByOrderId(orderFail)
    const actF = await activateFromCompletedTxn(txnF, { source: 'order_status_poll' })
    assert('failed not activated', actF.activated === false)
  } finally {
    await pool.query(`DELETE FROM device_subscriptions WHERE device_id = ANY($1::text[])`, [[deviceA, deviceB]])
    await pool.query(
      `DELETE FROM transactions WHERE order_id = ANY($1::text[])`,
      [[orderA, orderB, orderC].filter(Boolean)],
    )
    await pool.query(`DELETE FROM transactions WHERE device_id = ANY($1::text[]) AND raw_payload->>'test_fixture' = 'true'`, [
      [deviceA, deviceB],
    ])
  }
}

await runDbTests()

const failed = checks.filter((c) => !c.ok)
for (const c of checks.filter((x) => x.ok)) console.log(`PASS ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
for (const c of failed) console.error(`FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
