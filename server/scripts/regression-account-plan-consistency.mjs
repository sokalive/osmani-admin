/**
 * Permanent regression: Account boxes must come from ONE canonical entitlement.
 *
 * Deploy must fail if:
 *  - verify entitlement summary can mix LATERAL latest-txn metadata
 *  - payment activation still upserts when preserve_existing_active
 *  - upsert can rewrite transaction_id when expiry is unchanged
 *  - Account duration is forced to equal remaining_days
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'
import { validateVerifyResponse } from '../src/lib/subscriptionCanonicalValidator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
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

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

await check('stacking_preserve_existing_active_keeps_old_expiry', () => {
  const prev = '2026-07-29T21:00:00.000Z'
  const stack = computeStackedExpiryIso(prev, 7, Date.parse('2026-07-26T12:00:00.000Z'))
  assert.equal(stack.expiry_policy, 'preserve_existing_active')
  assert.equal(stack.expiresAt, prev)
  assert.equal(stack.purchasedDurationDays, 7)
})

await check('activation_skips_upsert_on_preserve_existing_active', () => {
  const src = read('src/lib/canonicalPaymentActivation.js')
  const start = src.indexOf("expiry_policy === 'preserve_existing_active'")
  assert.ok(start >= 0, 'preserve guard missing')
  const end = src.indexOf('\n  const fpRaw', start)
  assert.ok(end > start, 'preserve block boundary missing')
  const block = src.slice(start, end)
  assert.doesNotMatch(block, /upsertDeviceSubscriptionActive/)
  assert.match(block, /reason: 'preserve_existing_active'/)
  assert.match(block, /entitlement_unchanged:\s*true/)
})

await check('upsert_keeps_transaction_id_when_expiry_unchanged', () => {
  const src = read('src/billingStore.js')
  assert.match(
    src,
    /transaction_id = CASE[\s\S]*expires_at IS NOT DISTINCT FROM EXCLUDED\.expires_at[\s\S]*device_subscriptions\.transaction_id/,
  )
})

await check('entitlement_summary_has_no_lateral_latest_txn_mix', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('async function buildEntitlementVerifyTxnSummary')
  assert.ok(start >= 0)
  const end = src.indexOf('\nasync function ', start + 10)
  const fn = src.slice(start, end > start ? end : start + 8000)
  assert.doesNotMatch(fn, /LEFT JOIN LATERAL/)
  assert.doesNotMatch(fn, /getActivePlanByDurationDays/)
  assert.doesNotMatch(fn, /ORDER BY COALESCE\(t\.updated_at/)
  assert.match(fn, /pay\.order_id = ds\.transaction_id/)
})

await check('verify_does_not_fallback_latest_txn_for_empty_link', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('async function resolveVerifyTxnSummaryForDevice')
  const end = src.indexOf('\nexport async function tryFinalizeActivationForDevice', start)
  const fn = src.slice(start, end > start ? end : start + 6000)
  assert.doesNotMatch(
    fn,
    /!linkedId\)\s*\{\s*txn = await getLatestCompletedTransactionForDevice/,
  )
  assert.match(fn, /linkedId\.startsWith\('transfer:'\)/)
})

await check('package_duration_is_independent_of_remaining_days', () => {
  // Mid-cycle Wiki 1: Duration=7 (package) with Remaining≈3 is valid when the
  // entitlement timeline belongs to that same Wiki 1 purchase.
  // Forbidden: forcing duration === remaining, or mixing another Plan's labels.
  const midCycleExpiry = new Date(Date.now() + 3 * 86400000).toISOString()
  const built = {
    active: true,
    status: 'active',
    expiresAt: midCycleExpiry,
    expires_at: midCycleExpiry,
    remaining_days: 3,
    remainingDays: 3,
    remaining_seconds: 3 * 86400,
    amount: 3000,
    currency: 'TZS',
    plan_name: 'Wiki 1',
    planName: 'Wiki 1',
    plan_duration_days: 7,
    planDurationDays: 7,
    duration: 7,
    durationDays: 7,
    device_id: 'regression_account_plan',
  }
  const { payload } = validateVerifyResponse(built, {
    surface: 'verify',
    deviceId: 'regression_account_plan',
  })
  assert.equal(payload.plan_duration_days, 7)
  assert.equal(payload.duration, 7)
  assert.equal(payload.amount, 3000)
  assert.equal(payload.plan_name, 'Wiki 1')
  assert.ok(
    payload.remaining_days < payload.duration,
    `expected remaining (${payload.remaining_days}) < package duration (${payload.duration})`,
  )
})

await check('audit_repair_script_never_touches_expires_at', () => {
  const src = read('scripts/audit-account-plan-consistency.mjs')
  assert.match(src, /NEVER changes expires_at/)
  assert.doesNotMatch(src, /SET\s+expires_at\s*=/)
  assert.match(src, /SET transaction_id = \$2/)
})

const failed = results.filter((r) => !r.ok)
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      results,
    },
    null,
    2,
  ),
)
if (failed.length) process.exit(1)
