/**
 * Permanent regression: transactions are READ-ONLY for ownership.
 *
 * Deploy must fail if production code can derive current entitlement ownership from:
 *  - phone → latest completed payment
 *  - ORDER BY created_at / payment_time on transactions as ownership SoT
 *  - any helper that treats transaction history as the active subscription owner
 *
 * Canonical SoT remains: Device ID → device_subscriptions → linked txn (metadata only).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  refuseTransactionHistoryOwnership,
  TransactionsOwnershipError,
  TRANSACTIONS_OWNERSHIP_REFUSED,
  FORBIDDEN_OWNERSHIP_SURFACES,
} from '../src/lib/transactionOwnershipGuard.js'
import { getLatestCompletedTransactionByNormalizedPhone } from '../src/billingStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const srcRoot = path.join(root, 'src')
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

function walkJs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue
      walkJs(p, out)
    } else if (/\.(js|mjs|cjs)$/.test(ent.name)) {
      out.push(p)
    }
  }
  return out
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

await check('guard_refuses_transaction_history_ownership', () => {
  assert.throws(
    () => refuseTransactionHistoryOwnership('regression_test'),
    (e) => e instanceof TransactionsOwnershipError && e.code === TRANSACTIONS_OWNERSHIP_REFUSED,
  )
})

await check('phone_latest_txn_helper_permanently_refused', async () => {
  let threw = false
  try {
    await getLatestCompletedTransactionByNormalizedPhone('+255678089174')
  } catch (e) {
    threw = true
    assert.equal(e?.code, TRANSACTIONS_OWNERSHIP_REFUSED)
    assert.match(String(e?.message || e), /READ_ONLY|ownership|device_subscriptions/i)
  }
  assert.equal(threw, true)
})

await check('no_production_caller_of_phone_latest_txn', () => {
  const files = walkJs(srcRoot)
  const offenders = []
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    if (rel === 'src/billingStore.js') continue
    if (rel === 'src/lib/transactionOwnershipGuard.js') continue
    const src = fs.readFileSync(f, 'utf8')
    // Real call / import — ignore string constants naming the forbidden surface.
    if (
      /\bgetLatestCompletedTransactionByNormalizedPhone\s*\(/.test(src) ||
      /from ['"].*billingStore['"]/.test(src) &&
        src.includes('getLatestCompletedTransactionByNormalizedPhone') &&
        /import\s*\{[^}]*getLatestCompletedTransactionByNormalizedPhone/.test(src)
    ) {
      offenders.push(rel)
    }
  }
  assert.deepEqual(offenders, [], `forbidden callers: ${offenders.join(', ')}`)
})

await check('phone_latest_txn_sql_removed_from_helper', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('export async function getLatestCompletedTransactionByNormalizedPhone')
  assert.ok(start >= 0)
  const end = src.indexOf('\nexport async function listActiveDeviceIdsForPaymentPhone', start)
  const fn = src.slice(start, end > start ? end : start + 1200)
  assert.doesNotMatch(fn, /ORDER BY t\.created_at DESC/)
  assert.match(fn, /refuseTransactionHistoryOwnership/)
  assert.ok(fn.includes(FORBIDDEN_OWNERSHIP_SURFACES.LATEST_TXN_BY_PHONE))
})

await check('verify_access_uses_device_subscriptions_not_latest_payment', () => {
  const src = read('src/billingStore.js')
  assert.match(src, /export async function getDeviceSubscriptionAccessStateFast/)
  const start = src.indexOf('export async function getDeviceSubscriptionAccessStateFast')
  const end = src.indexOf('\nexport async function', start + 10)
  const fn = src.slice(start, end > start ? end : start + 5000)
  assert.match(fn, /FROM device_subscriptions/)
  assert.doesNotMatch(fn, /getLatestCompletedTransactionByNormalizedPhone/)
  assert.doesNotMatch(fn, /ORDER BY t\.created_at DESC/)
})

await check('activation_binds_completed_txn_device_id_only', () => {
  const src = read('src/lib/canonicalPaymentActivation.js')
  assert.match(src, /txn\.device_id/)
  assert.doesNotMatch(src, /getLatestCompletedTransactionByNormalizedPhone/)
  assert.doesNotMatch(src, /findActiveDeviceIdForPaymentPhone/)
})

await check('finalize_prefers_linked_order_before_device_latest', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('export async function tryFinalizeActivationForDevice')
  const end = src.indexOf('\nexport async function listDeviceUsers', start)
  const fn = src.slice(start, end > start ? end : start + 3500)
  assert.match(fn, /SELECT transaction_id/)
  assert.match(fn, /order_id = \$1/)
  assert.match(fn, /device_id = \$2/)
  assert.match(fn, /getLatestCompletedTransactionForDevice/)
  assert.doesNotMatch(fn, /getLatestCompletedTransactionByNormalizedPhone/)
  assert.doesNotMatch(fn, /tzPhoneCanonicalSql/)
})

await check('transfer_discovery_uses_device_subscriptions_not_txn_order', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('export async function listActiveDeviceIdsForPaymentPhone')
  const end = src.indexOf('export async function findActiveDeviceIdForPaymentPhone', start)
  const fn = src.slice(start, end > start ? end : start + 5000)
  // Candidate devices may come from txn history; active ownership must be ds.
  assert.match(fn, /FROM device_subscriptions ds/)
  assert.match(fn, /ds\.status = 'active'/)
  assert.doesNotMatch(fn, /ORDER BY t\.created_at DESC\s*\n\s*LIMIT 1/)
})

await check('auto_cross_device_migration_still_blocked', async () => {
  const { rejectUnauthorizedCrossDeviceMigration } = await import(
    '../src/lib/subscriptionEntitlementPolicy.js'
  )
  const block = rejectUnauthorizedCrossDeviceMigration({})
  assert.equal(block?.reason, 'automatic_cross_device_migration_disabled')
})

await check('guard_module_exported_for_deploy_gate', () => {
  assert.ok(fs.existsSync(path.join(root, 'src/lib/transactionOwnershipGuard.js')))
  const src = read('src/lib/transactionOwnershipGuard.js')
  assert.match(src, /transactions_read_only_for_ownership/)
  assert.match(src, /Device ID → device_subscriptions/)
})

const failed = results.filter((r) => !r.ok)
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      policy: 'transactions_read_only_for_ownership',
      results,
    },
    null,
    2,
  ),
)
if (failed.length) process.exit(1)
