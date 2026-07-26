/**
 * Permanent regression suite for subscription hardening.
 * Deploy must fail if any check fails.
 *
 * Covers: entitlement guard, canonical validator, stacking policy, cache SoT rules,
 * legacy lock surfaces, midnight-EAT math, no over-credit acceptance.
 */
import assert from 'node:assert/strict'
import {
  computeMidnightEatExpiryIso,
  computeRemainingCalendarDaysEat,
  computeStackedExpiryIso,
} from '../src/lib/subscriptionStacking.js'
import { assertWritableEntitlement, EntitlementGuardError } from '../src/lib/subscriptionEntitlementGuard.js'
import { validateCanonicalSubscriptionPayload } from '../src/lib/subscriptionCanonicalValidator.js'
import {
  getCachedSubscriptionAccess,
  getStaleCachedSubscriptionAccess,
  setCachedSubscriptionAccess,
  invalidateSubscriptionAccessCache,
  subscriptionAccessCacheStats,
} from '../src/lib/subscriptionAccessCache.js'
import {
  CANONICAL_ENGINE_VERSION,
  SUBSCRIPTION_SCHEMA_VERSION,
} from '../src/lib/subscriptionHardeningConstants.js'
import { LEGACY_PATHS as LOCK_PATHS, refuseLegacyExecution, LegacyLockError } from '../src/lib/subscriptionLegacyLock.js'

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

async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e?.message || String(e) })
    console.error(`FAIL  ${name}:`, e?.message || e)
  }
}

check('canonical_engine_version_present', () => {
  assert.equal(CANONICAL_ENGINE_VERSION, 'canonical-v1')
  assert.equal(SUBSCRIPTION_SCHEMA_VERSION, 1)
})

check('stacking_disabled_for_new_purchase', () => {
  const now = Date.parse('2026-07-25T12:00:00+03:00')
  const stack = computeStackedExpiryIso(null, 7, now)
  assert.equal(stack.stacked, false)
  assert.equal(stack.stacking_disabled, true)
  assert.equal(stack.expiry_policy, 'midnight_africa_dar_es_salaam')
  const expected = computeMidnightEatExpiryIso(7, now)
  assert.equal(stack.expiresAt, expected)
})

check('preserve_existing_active_never_shortens', () => {
  const now = Date.parse('2026-07-25T12:00:00+03:00')
  const prev = '2026-09-01T21:00:00.000Z' // still future
  const stack = computeStackedExpiryIso(prev, 3, now)
  assert.equal(stack.expiresAt, new Date(prev).toISOString())
  assert.equal(stack.expiry_policy, 'preserve_existing_active')
  assert.equal(stack.stacked, false)
})

check('remaining_days_non_negative', () => {
  const rem = computeRemainingCalendarDaysEat('2020-01-01T00:00:00.000Z')
  assert.equal(rem, 0)
})

await checkAsync('entitlement_guard_rejects_over_credit', async () => {
  const now = Date.parse('2026-07-25T12:00:00+03:00')
  let rejected = false
  try {
    await assertWritableEntitlement({
      deviceId: 'regression_device_001',
      orderId: 'regression_order_over',
      expiresAt: '2028-01-01T00:00:00.000Z',
      durationDays: 3,
      previousExpiresAt: null,
      source: 'payment',
      nowMs: now,
    })
  } catch (e) {
    rejected = e instanceof EntitlementGuardError || e?.reject === true
    assert.ok(rejected, 'expected EntitlementGuardError')
    assert.ok(['OVER_CREDIT', 'IMPOSSIBLE_DURATION'].includes(e.code) || e.code === 'OVER_CREDIT')
  }
  assert.equal(rejected, true)
})

await checkAsync('entitlement_guard_accepts_midnight_eat', async () => {
  const now = Date.parse('2026-07-25T12:00:00+03:00')
  const expiresAt = computeMidnightEatExpiryIso(7, now)
  const out = await assertWritableEntitlement({
    deviceId: 'regression_device_002',
    orderId: 'regression_order_ok',
    expiresAt,
    durationDays: 7,
    previousExpiresAt: null,
    source: 'payment',
    nowMs: now,
  })
  assert.equal(out.ok, true)
  assert.equal(out.canonical_engine_version, CANONICAL_ENGINE_VERSION)
})

await checkAsync('entitlement_guard_rejects_negative_window', async () => {
  let rejected = false
  try {
    await assertWritableEntitlement({
      deviceId: 'regression_device_003',
      expiresAt: '2020-01-01T00:00:00.000Z',
      durationDays: 7,
      source: 'payment',
    })
  } catch (e) {
    rejected = true
    assert.ok(e instanceof EntitlementGuardError)
  }
  assert.equal(rejected, true)
})

check('canonical_validator_sanitizes_active_while_revoked', () => {
  const { ok, payload, issues } = validateCanonicalSubscriptionPayload({
    active: true,
    status: 'revoked',
    admin_revoked_at: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    remaining_days: 100,
  })
  assert.equal(payload.active, false)
  assert.equal(payload.remaining_days, 0)
  assert.ok(issues.includes('active_while_revoked'))
  assert.equal(ok, false)
})

check('canonical_validator_clamps_expired_active', () => {
  const { payload } = validateCanonicalSubscriptionPayload({
    active: true,
    status: 'active',
    expiresAt: '2020-01-01T00:00:00.000Z',
    remaining_days: 5,
  })
  assert.equal(payload.active, false)
  assert.equal(payload.remaining_days, 0)
})

check('stale_cache_never_restores_entitlement', () => {
  const deviceId = 'cache_reg_device'
  setCachedSubscriptionAccess(deviceId, '', {
    status: 'active',
    active_now: true,
    expires_at: '2099-01-01T00:00:00.000Z',
    remaining_days: 30,
  }, 1)
  // Immediately expired TTL path: getStale must return undefined permanently
  assert.equal(getStaleCachedSubscriptionAccess(deviceId, ''), undefined)
  const stats = subscriptionAccessCacheStats()
  assert.equal(stats.stale_restore_disabled, true)
  assert.equal(stats.source_of_truth, 'database')
  invalidateSubscriptionAccessCache(deviceId)
  assert.equal(getCachedSubscriptionAccess(deviceId, ''), undefined)
})

check('legacy_refuse_execution_throws', () => {
  let threw = false
  try {
    refuseLegacyExecution(LOCK_PATHS.EXPIRY_OVERCREDIT_REPAIR)
  } catch (e) {
    threw = e instanceof LegacyLockError
  }
  assert.equal(threw, true)
  assert.ok(Object.values(LOCK_PATHS).length >= 4)
})

check('legacy_paths_exported', () => {
  assert.ok(LOCK_PATHS.HISTORICAL_NORMALIZATION_APPLY)
  assert.ok(LOCK_PATHS.EXPIRY_OVERCREDIT_REPAIR)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== subscription hardening regression ===')
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, failed_names: failed.map((f) => f.name) }, null, 2))

if (failed.length) {
  process.exit(1)
}
process.exit(0)
