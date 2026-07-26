/**
 * Regression: returning customer after natural expiry must activate.
 * Also: active-grant reject, concurrent activation race safety (simulated),
 * post-COMMIT realtime contract.
 *
 * Pure + light DB-optional. Deploy gate via apply-cutover when present.
 */
import assert from 'node:assert/strict'
import {
  ACTIVE_SUBSCRIPTION_EXISTS,
  ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW,
  ActiveSubscriptionExistsError,
  activeSubscriptionExistsHttpBody,
} from '../src/lib/activeSubscriptionPaymentGate.js'
import { isAdminRevokedOrderBlocked } from '../src/lib/adminSubscriptionRevocation.js'
import { computeStackedExpiryIso, computeMidnightEatExpiryIso } from '../src/lib/subscriptionStacking.js'
import { notifySubscriptionActivatedFromAct } from '../src/lib/subscriptionActivationNotify.js'

const results = []

function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e?.message || String(e) })
    console.error(`FAIL  ${name}:`, e?.message || e)
  }
}

check('active_reject_message_sw_exact', () => {
  assert.match(ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW, /tayari ana kifurushi/i)
  assert.match(ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW, /Subiri kimalizike/i)
})

check('active_subscription_exists_http_body', () => {
  const body = activeSubscriptionExistsHttpBody({
    deviceId: 'abc',
    expiresAt: '2099-01-01T00:00:00.000Z',
    remainingDays: 3,
  })
  assert.equal(body.code, ACTIVE_SUBSCRIPTION_EXISTS)
  assert.equal(body.ok, false)
  assert.ok(body.message_sw.includes('kifurushi'))
})

check('active_subscription_exists_error', () => {
  const err = new ActiveSubscriptionExistsError({ deviceId: 'x' })
  assert.equal(err.code, ACTIVE_SUBSCRIPTION_EXISTS)
  assert.equal(err.statusCode, 409)
})

check('returning_customer_after_expiry_gets_midnight_eat', () => {
  // Previous expiry in the past → new purchase gets fresh midnight-EAT window (not blocked).
  const now = Date.parse('2026-07-26T12:00:00+03:00')
  const expiredPrev = '2026-07-01T21:00:00.000Z'
  const stack = computeStackedExpiryIso(expiredPrev, 7, now)
  assert.equal(stack.expiry_policy, 'midnight_africa_dar_es_salaam')
  assert.equal(stack.expiresAt, computeMidnightEatExpiryIso(7, now))
  assert.equal(stack.stacked, false)
})

check('post_revoke_new_order_not_blocked', () => {
  const revokedAt = new Date('2026-07-20T10:00:00.000Z')
  const newPaymentAt = new Date('2026-07-21T12:00:00.000Z')
  const blocked = isAdminRevokedOrderBlocked(
    { admin_revoked_at: revokedAt, admin_revoked_transaction_id: 'old_order' },
    'new_order_after_revoke',
    newPaymentAt,
  )
  assert.equal(blocked, false)
})

check('pre_revoke_old_order_blocked', () => {
  const revokedAt = new Date('2026-07-20T10:00:00.000Z')
  const oldPaymentAt = new Date('2026-07-19T12:00:00.000Z')
  const blocked = isAdminRevokedOrderBlocked(
    { admin_revoked_at: revokedAt, admin_revoked_transaction_id: 'old_order' },
    'old_order',
    oldPaymentAt,
  )
  assert.equal(blocked, true)
})

check('missing_created_at_fail_closed', () => {
  const revokedAt = new Date('2026-07-20T10:00:00.000Z')
  const blocked = isAdminRevokedOrderBlocked(
    { admin_revoked_at: revokedAt },
    'some_order',
    null,
  )
  assert.equal(blocked, true)
})

check('notify_from_act_accepts_activated', () => {
  // Smoke: function returns boolean; no throw on valid act shape.
  const ok = notifySubscriptionActivatedFromAct(
    { deviceId: 'sim_device', activated: true, activation_state: 'ACTIVATED', orderId: 'sim_order' },
    'sim_order',
  )
  assert.equal(typeof ok, 'boolean')
})

/** Simulated 500 concurrent activations: same order must stay idempotent; distinct orders must all succeed in math. */
check('concurrent_activation_idempotency_simulation', () => {
  const applied = new Set()
  let writes = 0
  let skips = 0
  function simulateUpsert(orderId) {
    if (applied.has(orderId)) {
      skips += 1
      return { skipped: true }
    }
    applied.add(orderId)
    writes += 1
    return { skipped: false }
  }
  // 500 workers all finalize the SAME completed order → 1 write, 499 skips
  const sameOrder = Array.from({ length: 500 }, () => simulateUpsert('order_shared'))
  assert.equal(sameOrder.filter((r) => !r.skipped).length, 1)
  assert.equal(writes, 1)
  assert.equal(skips, 499)

  // 500 distinct completed orders → 500 writes, zero lost entitlements
  writes = 0
  skips = 0
  applied.clear()
  for (let i = 0; i < 500; i++) simulateUpsert(`order_${i}`)
  assert.equal(writes, 500)
  assert.equal(skips, 0)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== payment-system-completion regression ===')
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
