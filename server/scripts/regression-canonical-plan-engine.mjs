/**
 * Permanent regression: canonical Plan engine.
 *
 * The Admin `plans` table is the ONLY source of plan price/duration/name.
 * Deploy must fail if:
 *  - any activation path could silently substitute a default duration (the old `|| 30`),
 *  - grants accept a malformed plan id instead of rejecting,
 *  - the newly-activated 409 gate contract or the payment congratulations SSE contract breaks.
 */
import assert from 'node:assert/strict'
import {
  computeDeviceSubscriptionExpiryAfterPurchase,
  grantManualDeviceSubscription,
  insertOfferCodeRow,
} from '../src/billingStore.js'
import {
  activeSubscriptionExistsHttpBody,
  ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW,
} from '../src/lib/activeSubscriptionPaymentGate.js'
import {
  buildPaymentCongratsSsePayload,
  notifySubscriptionActivatedFromAct,
} from '../src/lib/subscriptionActivationNotify.js'
import { deviceSubscriptionBus } from '../src/lib/deviceSubscriptionBus.js'

const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e?.message || String(e) })
    console.error(`FAIL  ${name}:`, e?.message || e)
  }
}

async function expectThrow(fn, pattern) {
  let threw = false
  try {
    await fn()
  } catch (e) {
    threw = true
    if (pattern) assert.match(String(e?.message || e), pattern)
  }
  assert.equal(threw, true, 'expected the call to throw')
}

// --- No default-duration fallback (old `|| 30`) anywhere in the purchase expiry math ---

await check('expiry_math_rejects_missing_duration', async () => {
  await expectThrow(
    () => computeDeviceSubscriptionExpiryAfterPurchase('regression_device_cpe', null),
    /invalid duration_days/i,
  )
})

await check('expiry_math_rejects_zero_and_nan_duration', async () => {
  await expectThrow(
    () => computeDeviceSubscriptionExpiryAfterPurchase('regression_device_cpe', 0),
    /invalid duration_days/i,
  )
  await expectThrow(
    () => computeDeviceSubscriptionExpiryAfterPurchase('regression_device_cpe', 'abc'),
    /invalid duration_days/i,
  )
})

// --- Grants reject malformed plan ids instead of guessing ---

await check('manual_grant_rejects_malformed_plan_id', async () => {
  await expectThrow(
    () => grantManualDeviceSubscription('regression_device_cpe', 7, null, { planId: 0 }),
    /Invalid plan_id/i,
  )
  await expectThrow(
    () => grantManualDeviceSubscription('regression_device_cpe', 7, null, { planId: -5 }),
    /Invalid plan_id/i,
  )
  await expectThrow(
    () => grantManualDeviceSubscription('regression_device_cpe', 7, null, { planId: 1.5 }),
    /Invalid plan_id/i,
  )
})

await check('offer_code_rejects_malformed_plan_id', async () => {
  await expectThrow(() => insertOfferCodeRow({ durationDays: 7, planId: -1 }), /Invalid plan_id/i)
  await expectThrow(() => insertOfferCodeRow({ durationDays: 7, planId: 2.7 }), /Invalid plan_id/i)
})

// --- Newly-activated purchase must never read as "kifurushi kinaendelea" ---

await check('gate_409_marks_newly_activated_purchase', async () => {
  const body = activeSubscriptionExistsHttpBody({
    deviceId: 'regression_device_cpe',
    expiresAt: '2099-01-01T00:00:00.000Z',
    remainingDays: 7,
    newlyActivated: true,
  })
  assert.equal(body.newly_activated, true)
  assert.equal(body.reason, 'newly_activated_subscription')
  assert.notEqual(body.message_sw, ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW)
  assert.match(body.message_sw, /kimewashwa/i)
})

await check('gate_409_keeps_classic_message_for_old_subscriptions', async () => {
  const body = activeSubscriptionExistsHttpBody({
    deviceId: 'regression_device_cpe',
    expiresAt: '2099-01-01T00:00:00.000Z',
    remainingDays: 7,
    newlyActivated: false,
  })
  assert.equal(body.newly_activated, false)
  assert.equal(body.reason, 'active_subscription_exists')
  assert.equal(body.message_sw, ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW)
})

// --- Payment congratulations SSE contract ---

await check('payment_congrats_payload_contract', async () => {
  const p = buildPaymentCongratsSsePayload({ orderId: 'order_x' })
  assert.equal(p.showPopup, true)
  assert.equal(p.orderId, 'order_x')
  assert.equal(p.title, 'Hongera!')
  assert.equal(p.reason, 'payment_activated')
})

await check('payment_congrats_only_on_fresh_activation', async () => {
  const seen = []
  const listener = (payload) => seen.push(payload)
  deviceSubscriptionBus.on('payment_congrats', listener)
  try {
    notifySubscriptionActivatedFromAct(
      { deviceId: 'regression_device_cpe', activated: true, activation_state: 'ACTIVATED' },
      'order_fresh',
    )
    notifySubscriptionActivatedFromAct(
      { deviceId: 'regression_device_cpe', activated: false, entitlement_active: true, activation_state: 'ALREADY_APPLIED' },
      'order_replay',
    )
  } finally {
    deviceSubscriptionBus.off('payment_congrats', listener)
  }
  assert.equal(seen.length, 1, 'exactly one congrats for the fresh activation')
  assert.equal(seen[0].paymentCongrats.orderId, 'order_fresh')
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== canonical plan engine regression ===')
console.log(
  JSON.stringify(
    {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      failed_names: failed.map((f) => f.name),
    },
    null,
    2,
  ),
)

if (failed.length) process.exit(1)
process.exit(0)
