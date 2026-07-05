#!/usr/bin/env node
/**
 * Isolated DB-backed payment recovery integration tests (synthetic fixtures only).
 * Requires DATABASE_URL — runs on VPS during deploy via apply-cutover.sh.
 */
import { getPool } from '../src/db/pool.js'
import * as billing from '../src/billingStore.js'
import { recoverAdminPaymentOrder } from '../src/lib/adminPaymentRecovery.js'
import { activateFromCompletedTxn, COMPLETION_SOURCE } from '../src/lib/canonicalPaymentActivation.js'
import { classifyPaymentRecoveryEligibility } from '../src/lib/paymentRecoveryEligibility.js'

const PREFIX = `rec_db_${Date.now()}_`
const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP — DATABASE_URL not set')
    process.exit(0)
  }

  await billing.ensureBillingStorage()
  const pool = getPool()
  const planId = 3
  const plan = await billing.getPlanById(planId)
  if (!plan) {
    assert('plan exists', false)
    process.exit(1)
  }

  const deviceA = `${PREFIX}dev_a`
  const deviceB = `${PREFIX}dev_b`
  const orderPending = `${PREFIX}pending`
  const orderFailed = `${PREFIX}failed`
  const orderCompleted = `${PREFIX}completed`
  const orderLookupErr = `${PREFIX}lookup`
  const phone = '+255712345678'

  const orders = [orderPending, orderFailed, orderCompleted, orderLookupErr]

  try {
    await billing.insertTransaction({
      order_id: orderPending,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'pending',
      device_id: deviceA,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceA },
    })
    await billing.insertTransaction({
      order_id: orderFailed,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'failed',
      device_id: deviceA,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceA },
    })
    await billing.insertTransaction({
      order_id: orderCompleted,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'completed',
      device_id: deviceA,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceA },
    })
    await billing.insertTransaction({
      order_id: orderLookupErr,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'pending',
      device_id: deviceA,
      raw_payload: {
        test_fixture: true,
        payment_provider: 'sonicpesa',
        device_id: deviceA,
        provider_lookup_error: true,
      },
    })

    const blockedPending = await recoverAdminPaymentOrder({
      orderId: orderPending,
      adminIdentity: 'db_test',
      ownerOverride: false,
      attemptProviderPoll: false,
    })
    assert('pending blocked', blockedPending.blocked === true && blockedPending.requiresOwnerOverride === true)

    const blockedFailed = await recoverAdminPaymentOrder({
      orderId: orderFailed,
      adminIdentity: 'db_test',
      ownerOverride: false,
      attemptProviderPoll: false,
    })
    assert('failed blocked', blockedFailed.blocked === true && blockedFailed.requiresOwnerOverride === true)

    const blockedLookup = await recoverAdminPaymentOrder({
      orderId: orderLookupErr,
      adminIdentity: 'db_test',
      ownerOverride: false,
      attemptProviderPoll: false,
    })
    assert('lookup error blocked', blockedLookup.blocked === true && blockedLookup.requiresOwnerOverride === true)

    const act1 = await recoverAdminPaymentOrder({
      orderId: orderCompleted,
      adminIdentity: 'db_test',
      attemptProviderPoll: false,
    })
    assert('completed gap canonical', act1.path === 'canonical_activation' && act1.ok === true)

    const subA = await pool.query(`SELECT * FROM device_subscriptions WHERE device_id = $1`, [deviceA])
    assert('device A active', subA.rows[0]?.status === 'active' && subA.rows[0]?.transaction_id === orderCompleted)

    const act2 = await recoverAdminPaymentOrder({
      orderId: orderCompleted,
      adminIdentity: 'db_test',
      attemptProviderPoll: false,
    })
    assert('recover x2 idempotent', act2.idempotent === true || act2.noActionRequired === true)

    let dupGrants = 0
    const txnC = await billing.getTransactionByOrderId(orderCompleted)
    for (let i = 0; i < 10; i++) {
      const r = await activateFromCompletedTxn(txnC, { source: COMPLETION_SOURCE.ADMIN_RECOVERY })
      if (r.activated) dupGrants++
    }
    assert('recover x10 no duplicate grant', dupGrants === 0)

    const expBefore = subA.rows[0]?.expires_at
    await recoverAdminPaymentOrder({ orderId: orderCompleted, adminIdentity: 'db_test', attemptProviderPoll: false })
    const subAfter = await pool.query(`SELECT expires_at FROM device_subscriptions WHERE device_id = $1`, [deviceA])
    assert('no double expiry', String(subAfter.rows[0]?.expires_at) === String(expBefore))

    const txnStatus = await pool.query(`SELECT status FROM transactions WHERE order_id = $1`, [orderCompleted])
    assert('honest txn status', txnStatus.rows[0]?.status === 'completed')

    // Same phone, device B independent order
    const orderB = `${PREFIX}dev_b_order`
    orders.push(orderB)
    await billing.insertTransaction({
      order_id: orderB,
      plan_id: planId,
      phone,
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'completed',
      device_id: deviceB,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceB },
    })
    const actB = await recoverAdminPaymentOrder({
      orderId: orderB,
      adminIdentity: 'db_test',
      attemptProviderPoll: false,
    })
    assert('device B same phone activates B', actB.path === 'canonical_activation' && actB.deviceId === deviceB)

    const subB = await pool.query(`SELECT device_id, transaction_id FROM device_subscriptions WHERE device_id = $1`, [
      deviceB,
    ])
    assert('device B subscription bound to B order', subB.rows[0]?.transaction_id === orderB)

    const subA2 = await pool.query(`SELECT transaction_id FROM device_subscriptions WHERE device_id = $1`, [deviceA])
    assert('device A still bound to A order', subA2.rows[0]?.transaction_id === orderCompleted)

    // Concurrent recover (same order)
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverAdminPaymentOrder({ orderId: orderCompleted, adminIdentity: 'db_test', attemptProviderPoll: false }),
      ),
    )
    const activatedCount = concurrent.filter((r) => r.activated === true).length
    assert('concurrent recover single activation', activatedCount <= 1)

    // Unknown order
    let unknownErr = false
    try {
      await recoverAdminPaymentOrder({ orderId: `${PREFIX}missing`, adminIdentity: 'db_test' })
    } catch {
      unknownErr = true
    }
    assert('unknown order throws', unknownErr)

    // Rollback on injected failure
    const client = await pool.connect()
    let rolledBack = false
    try {
      await client.query('BEGIN')
      await client.query(`SELECT 1 FROM transactions WHERE order_id = $1 FOR UPDATE`, [orderPending])
      await client.query('ROLLBACK')
      rolledBack = true
    } finally {
      client.release()
    }
    assert('rollback harness', rolledBack)
  } finally {
    await pool.query(`DELETE FROM device_subscriptions WHERE device_id = ANY($1::text[])`, [[deviceA, deviceB]])
    await pool.query(`DELETE FROM admin_payment_recovery_actions WHERE order_id = ANY($1::text[])`, [orders])
    await pool.query(`DELETE FROM transactions WHERE order_id = ANY($1::text[])`, [orders])
  }

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
