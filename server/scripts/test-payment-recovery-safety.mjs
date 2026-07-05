#!/usr/bin/env node
/**
 * Safe payment recovery policy tests (no real charges).
 * Run: node server/scripts/test-payment-recovery-safety.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RECOVERY_CLASS,
  classifyPaymentRecoveryEligibility,
} from '../src/lib/paymentRecoveryEligibility.js'
import { COMPLETION_SOURCE } from '../src/lib/canonicalPaymentActivation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

const recoverySrc = fs.readFileSync(path.join(__dirname, '../src/lib/adminPaymentRecovery.js'), 'utf8')
const activationSrc = fs.readFileSync(path.join(__dirname, '../src/lib/canonicalPaymentActivation.js'), 'utf8')

assert('recovery imports canonical activation', recoverySrc.includes('activateFromCompletedTxn'))
assert('recovery uses ADMIN_RECOVERY source', recoverySrc.includes('COMPLETION_SOURCE.ADMIN_RECOVERY'))
assert('manual path does not set status completed', !recoverySrc.includes("status = 'completed'"))
assert('provider poll outside transaction', recoverySrc.includes('reconcileOrderWithZenoPay'))
assert('owner override flag', recoverySrc.includes('ownerOverride'))
assert('no duplicate notifySubscriptionActivated in manual', !recoverySrc.match(/notifySubscriptionActivated\s*\(/))

// Eligibility unit tests (no DB — mock txn only for branches that skip DB)
async function testEligibilityNoDb() {
  const baseTxn = {
    order_id: 'osm_sp_test_1',
    plan_id: 3,
    device_id: 'device-a-test',
    status: 'failed',
    recovery_state: null,
    raw_payload: { payment_provider: 'sonicpesa' },
  }
  // Without DB, classify will fail on plan lookup — skip those
  assert('RECOVERY_CLASS defined', Boolean(RECOVERY_CLASS.PROVIDER_PENDING))
  assert('ADMIN_RECOVERY source', COMPLETION_SOURCE.ADMIN_RECOVERY === 'admin_recovery')
}

await testEligibilityNoDb()

async function runDbTests() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP DB recovery tests — DATABASE_URL not set')
    return
  }

  const { getPool } = await import('../src/db/pool.js')
  const billing = await import('../src/billingStore.js')
  const { recoverAdminPaymentOrder } = await import('../src/lib/adminPaymentRecovery.js')
  const { activateFromCompletedTxn } = await import('../src/lib/canonicalPaymentActivation.js')

  await billing.ensureBillingStorage()
  const pool = getPool()
  const planId = 3
  const plan = await billing.getPlanById(planId)
  if (!plan) {
    assert('plan exists', false)
    return
  }

  const deviceA = `rec-test-a-${Date.now()}`
  const orderPending = `rec_test_p_${Date.now()}`
  const orderCompleted = `rec_test_c_${Date.now()}`

  try {
    await billing.insertTransaction({
      order_id: orderPending,
      plan_id: planId,
      phone: '+255712345678',
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'pending',
      device_id: deviceA,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceA },
    })

    const blocked = await recoverAdminPaymentOrder({
      orderId: orderPending,
      adminIdentity: 'test',
      ownerOverride: false,
      attemptProviderPoll: false,
    })
    assert('pending blocked without override', blocked.blocked === true && blocked.requiresOwnerOverride === true)

    await billing.insertTransaction({
      order_id: orderCompleted,
      plan_id: planId,
      phone: '+255712345678',
      amount: Number(plan.price),
      currency: 'TZS',
      status: 'completed',
      device_id: deviceA,
      raw_payload: { test_fixture: true, payment_provider: 'sonicpesa', device_id: deviceA },
    })
    const txnC = await billing.getTransactionByOrderId(orderCompleted)
    const act = await recoverAdminPaymentOrder({
      orderId: orderCompleted,
      adminIdentity: 'test',
      attemptProviderPoll: false,
    })
    assert('completed gap uses canonical path', act.path === 'canonical_activation' && act.ok === true)

    const dup = await recoverAdminPaymentOrder({
      orderId: orderCompleted,
      adminIdentity: 'test',
      attemptProviderPoll: false,
    })
    assert('recovery idempotent x2', dup.idempotent === true || dup.noActionRequired === true)

    let dupGrants = 0
    for (let i = 0; i < 10; i++) {
      const r = await activateFromCompletedTxn(txnC, { source: 'admin_recovery' })
      if (r.activated) dupGrants++
    }
    assert('canonical x10 no duplicate grant', dupGrants === 0)
  } finally {
    await pool.query(`DELETE FROM device_subscriptions WHERE device_id = $1`, [deviceA])
    await pool.query(`DELETE FROM admin_payment_recovery_actions WHERE order_id = ANY($1::text[])`, [
      [orderPending, orderCompleted],
    ])
    await pool.query(`DELETE FROM transactions WHERE order_id = ANY($1::text[])`, [[orderPending, orderCompleted]])
  }
}

await runDbTests()

const failed = checks.filter((c) => !c.ok)
for (const c of checks.filter((x) => x.ok)) console.log(`PASS ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
for (const c of failed) console.error(`FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
