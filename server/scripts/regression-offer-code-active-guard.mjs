#!/usr/bin/env node
/**
 * Regression: Offer Code must REJECT when device already has a future expires_at.
 *
 * Reproduces the production bug fixed for code 281606:
 *   - device had legacy future expires_at (e.g. 2026-10-01)
 *   - redeem computed preserve_existing_active
 *   - grant still succeeded and attached new package metadata to the old timeline
 *
 * Expected after fix:
 *   - stacking engine may still return preserve_existing_active (payment path uses it)
 *   - grantManualDeviceSubscription MUST reject before insert/upsert
 *   - no new manual_subscription_grants row, no expiry mutation
 *
 *   node scripts/regression-offer-code-active-guard.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeMidnightEatExpiryIso,
  computeStackedExpiryIso,
  eatMidnightUtcIso,
} from '../src/lib/subscriptionStacking.js'
import { ActiveSubscriptionExistsError } from '../src/lib/activeSubscriptionPaymentGate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
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

const t0 = Date.UTC(2026, 7, 8, 0, 22, 22) // 08 Aug 2026 redeem-time-ish
const legacyFuture = '2026-10-01T15:39:11.901Z'
const packages = [
  { label: 'Wiki_1', days: 7 },
  { label: 'Mwezi_1', days: 30 },
  { label: 'Miezi_2', days: 60 },
  { label: 'Mwaka', days: 365 },
]

// --- A. Fresh device: midnight-EAT durations unchanged ---
for (const pkg of packages) {
  check(`fresh_${pkg.label}_${pkg.days}d_midnight_eat`, () => {
    const out = computeStackedExpiryIso(null, pkg.days, t0)
    assert.equal(out.expiry_policy, 'midnight_africa_dar_es_salaam')
    assert.equal(out.stacked, false)
    assert.equal(out.expiresAt, computeMidnightEatExpiryIso(pkg.days, t0))
    assert.equal(out.purchasedDurationDays, pkg.days)
  })
}

check('fresh_mwezi_exactly_30_from_aug8', () => {
  const out = computeStackedExpiryIso(null, 30, t0)
  assert.equal(out.expiresAt, '2026-09-06T21:00:00.000Z') // 07 Sep 00:00 EAT
  assert.equal(out.expiresAt, eatMidnightUtcIso(2026, 9, 7))
})

// --- B. Existing future expiry: engine preserves (payment behavior unchanged) ---
for (const pkg of packages) {
  check(`engine_preserve_${pkg.label}_keeps_legacy_expiry`, () => {
    const out = computeStackedExpiryIso(legacyFuture, pkg.days, t0)
    assert.equal(out.expiry_policy, 'preserve_existing_active')
    assert.equal(out.expiresAt, legacyFuture)
    assert.equal(out.stacked, false)
  })
}

// --- B continued: grant path MUST reject preserve (offer/manual) ---
const storeSrc = fs.readFileSync(path.join(root, 'src/billingStore.js'), 'utf8')
const redeemRouteSrc = fs.readFileSync(path.join(root, 'src/routes/subscription.js'), 'utf8')
const paymentActSrc = fs.readFileSync(path.join(root, 'src/lib/canonicalPaymentActivation.js'), 'utf8')

check('grant_rejects_preserve_existing_active_before_insert', () => {
  const start = storeSrc.indexOf('export async function grantManualDeviceSubscription')
  const end = storeSrc.indexOf('export async function grantCustomManualDeviceSubscription')
  assert.ok(start >= 0 && end > start, 'grant function bounds')
  const block = storeSrc.slice(start, end)
  assert.match(block, /expiry_policy === 'preserve_existing_active'/)
  assert.match(block, /ActiveSubscriptionExistsError/)
  // Must compute stack before INSERT so a rejected redeem creates no grant row.
  const stackIdx = block.indexOf('computeDeviceSubscriptionExpiryAfterPurchase')
  const rejectIdx = block.indexOf("expiry_policy === 'preserve_existing_active'")
  const insertIdx = block.indexOf('INSERT INTO manual_subscription_grants')
  assert.ok(stackIdx >= 0 && rejectIdx > stackIdx, 'stack then reject')
  assert.ok(insertIdx > rejectIdx, 'reject before INSERT grant')
})

check('compute_device_expiry_exposes_expiry_policy', () => {
  const start = storeSrc.indexOf('export async function computeDeviceSubscriptionExpiryAfterPurchase')
  const end = storeSrc.indexOf('export async function subscriptionExpiresAtEndOfDay')
  const block = storeSrc.slice(start, end)
  assert.match(block, /expiry_policy:\s*stack\.expiry_policy/)
})

check('redeem_route_maps_active_subscription_to_409', () => {
  const start = redeemRouteSrc.indexOf("'/subscription/redeem-offer-code'")
  assert.ok(start >= 0)
  const block = redeemRouteSrc.slice(start, start + 2500)
  assert.match(block, /ActiveSubscriptionExistsError/)
  assert.match(block, /status\(409\)/)
  assert.match(block, /activeSubscriptionExistsHttpBody/)
})

check('payment_activation_still_skips_upsert_on_preserve_unchanged', () => {
  assert.match(paymentActSrc, /expiry_policy === 'preserve_existing_active'/)
  assert.match(paymentActSrc, /skip entitlement upsert|preserve_existing_active/)
  assert.match(paymentActSrc, /reason: 'preserve_existing_active'/)
  // Payment must NOT throw ActiveSubscriptionExistsError on preserve (different product rule).
  const start = paymentActSrc.indexOf("expiry_policy === 'preserve_existing_active'")
  const block = paymentActSrc.slice(start, start + 1200)
  assert.doesNotMatch(block, /throw new ActiveSubscriptionExistsError/)
})

check('active_subscription_error_semantics_unchanged', () => {
  const err = new ActiveSubscriptionExistsError({
    blocked: true,
    deviceId: 'regression_offer_guard_device',
    expiresAt: legacyFuture,
    reason: 'preserve_existing_active',
  })
  assert.equal(err.name, 'ActiveSubscriptionExistsError')
  assert.equal(err.code, 'ACTIVE_SUBSCRIPTION_EXISTS')
  assert.equal(err.statusCode, 409)
  assert.match(String(err.message), /kifurushi kinachoendelea/i)
})

// Simulated failure-mode script (no DB): device with future expiry → stack preserve → grant must refuse.
check('repro_281606_style_preserve_must_be_rejected_by_grant_contract', () => {
  const stack = computeStackedExpiryIso(legacyFuture, 30, t0)
  assert.equal(stack.expiry_policy, 'preserve_existing_active')
  assert.equal(stack.expiresAt, legacyFuture)
  // Grant contract (mirrored from source): refuse before creating grant / mutating expiry.
  const mustReject = stack.expiry_policy === 'preserve_existing_active'
  assert.equal(mustReject, true)
  // Old expiry unchanged in this pure model.
  assert.equal(stack.expiresAt, legacyFuture)
  // Fresh 30d would have been Sept 7 EAT — prove they differ (the production mismatch).
  const fresh = computeMidnightEatExpiryIso(30, t0)
  assert.notEqual(legacyFuture, fresh)
})

check('offer_redeem_still_uses_preferDurationSnapshot_and_phone_sms_flags', () => {
  assert.match(storeSrc, /preferDurationSnapshot:\s*true/)
  assert.match(storeSrc, /allowDevicePhoneFallback:\s*false/)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== offer-code active-guard regression ===')
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
