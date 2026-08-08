#!/usr/bin/env node
/**
 * Offer Codes verification (backend only — no app, no OTA).
 *
 * Checks:
 *  1) Required package durations use the same midnight-EAT engine as paid subscriptions
 *  2) Code History "Mwisho wa Code" resolves to subscription end (not code shelf-life)
 *  3) SMS fires only when an admin-entered phone exists on the code
 *  4) Redeem prefers frozen offer_codes.duration_days (payment snapshot parity)
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
import { resolveOfferCodeSubscriptionExpiresAt } from '../src/billingStore.js'

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

const REQUIRED = [
  { label: 'Wiki 1', days: 7, price: 3000 },
  { label: 'Mwezi 1', days: 30, price: 5000 },
  { label: 'Miezi 2', days: 60, price: 15000 },
  { label: 'Mwaka', days: 365, price: 40000 },
]

const t0 = Date.UTC(2026, 6, 25, 8, 0, 0) // 25 Jul 2026 08:00 UTC

for (const pkg of REQUIRED) {
  check(`duration_${pkg.label.replace(/\s+/g, '_')}_${pkg.days}d`, () => {
    const out = computeStackedExpiryIso(null, pkg.days, t0)
    const expected = computeMidnightEatExpiryIso(pkg.days, t0)
    assert.equal(out.expiry_policy, 'midnight_africa_dar_es_salaam')
    assert.equal(out.stacked, false)
    assert.equal(out.expiresAt, expected)
    assert.equal(out.purchasedDurationDays, pkg.days)
  })
}

check('wiki1_exactly_7_calendar_days', () => {
  const out = computeStackedExpiryIso(null, 7, t0)
  assert.equal(out.expiresAt, eatMidnightUtcIso(2026, 8, 1))
})

check('mwezi1_exactly_30_days', () => {
  const out = computeStackedExpiryIso(null, 30, t0)
  assert.equal(out.expiresAt, computeMidnightEatExpiryIso(30, t0))
})

check('miezi2_exactly_60_days', () => {
  const out = computeStackedExpiryIso(null, 60, t0)
  assert.equal(out.expiresAt, computeMidnightEatExpiryIso(60, t0))
})

check('mwaka_exactly_365_days', () => {
  const out = computeStackedExpiryIso(null, 365, t0)
  assert.equal(out.expiresAt, computeMidnightEatExpiryIso(365, t0))
})

check('mwisho_unused_equals_expected_engine_expiry', () => {
  const unused = { duration_days: 7, used_at: null, subscription_expires_at: null }
  const got = resolveOfferCodeSubscriptionExpiresAt(unused, t0)
  assert.equal(got, computeMidnightEatExpiryIso(7, t0))
})

check('mwisho_used_prefers_stored_subscription_expires_at', () => {
  const stored = '2026-08-01T21:00:00.000Z'
  const used = {
    duration_days: 7,
    used_at: new Date(t0).toISOString(),
    subscription_expires_at: stored,
  }
  assert.equal(resolveOfferCodeSubscriptionExpiresAt(used, t0), stored)
})

check('mwisho_used_without_snapshot_reconstructs_from_used_at', () => {
  const usedAt = Date.UTC(2026, 7, 10, 10, 0, 0)
  const used = { duration_days: 30, used_at: new Date(usedAt).toISOString(), subscription_expires_at: null }
  assert.equal(
    resolveOfferCodeSubscriptionExpiresAt(used, t0),
    computeMidnightEatExpiryIso(30, usedAt),
  )
})

check('mwisho_never_uses_code_shelf_365', () => {
  // Shelf was historically returned as expiresAt (~365d) — must not equal Wiki 1 mwisho.
  const shelf = computeMidnightEatExpiryIso(365, t0)
  const wiki1 = resolveOfferCodeSubscriptionExpiresAt(
    { duration_days: 7, used_at: null, subscription_expires_at: null },
    t0,
  )
  assert.notEqual(wiki1, shelf)
})

// Source-level contracts (offer path only — do not require live DB)
const storeSrc = fs.readFileSync(path.join(root, 'src/billingStore.js'), 'utf8')
const adminSrc = fs.readFileSync(path.join(root, 'src/routes/offerCodesAdmin.js'), 'utf8')
const tablesSrc = fs.readFileSync(path.join(root, 'src/db/billingTables.js'), 'utf8')

check('redeem_uses_preferDurationSnapshot', () => {
  assert.match(storeSrc, /preferDurationSnapshot:\s*true/)
})

check('redeem_disables_device_phone_fallback_for_sms', () => {
  assert.match(storeSrc, /allowDevicePhoneFallback:\s*false/)
})

check('redeem_persists_subscription_expires_at', () => {
  assert.match(storeSrc, /subscription_expires_at\s*=\s*\$3::timestamptz/)
})

check('schema_has_customer_phone_and_subscription_expires_at', () => {
  assert.match(tablesSrc, /customer_phone TEXT/)
  assert.match(tablesSrc, /subscription_expires_at TIMESTAMPTZ/)
})

check('generate_accepts_optional_phone', () => {
  assert.match(adminSrc, /body\.phone/)
  assert.match(storeSrc, /customer_phone/)
})

check('sms_only_when_phone_present_contract', () => {
  // grantManualDeviceSubscription sends SMS only when smsPhone is truthy;
  // offer redeem passes allowDevicePhoneFallback:false so empty admin phone ⇒ no SMS.
  const grantBlock = storeSrc.slice(
    storeSrc.indexOf('export async function grantManualDeviceSubscription'),
    storeSrc.indexOf('export async function grantCustomManualDeviceSubscription'),
  )
  assert.match(grantBlock, /if\s*\(\s*smsPhone\s*\)/)
  assert.match(grantBlock, /notifyManualGrantActivated/)
  assert.match(grantBlock, /allowDevicePhoneFallback\s*!==\s*false/)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== offer codes duration verification ===')
console.log(
  JSON.stringify(
    {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      failed_names: failed.map((f) => f.name),
      packages: REQUIRED,
    },
    null,
    2,
  ),
)

if (failed.length) process.exit(1)
process.exit(0)
