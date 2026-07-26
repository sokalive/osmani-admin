/**
 * Permanent regression: Device ID isolation guarantee.
 *
 * Deploy must fail if phone can become an ownership key that picks the wrong
 * sibling entitlement, or if verify/cache/activation can mix devices.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectUnauthorizedCrossDeviceMigration } from '../src/lib/subscriptionEntitlementPolicy.js'
import {
  getCachedSubscriptionAccess,
  setCachedSubscriptionAccess,
  invalidateSubscriptionAccessCache,
  clearAllSubscriptionAccessCache,
} from '../src/lib/subscriptionAccessCache.js'

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

await check('auto_cross_device_migration_permanently_blocked', () => {
  const block = rejectUnauthorizedCrossDeviceMigration({})
  assert.ok(block)
  assert.equal(block.reason, 'automatic_cross_device_migration_disabled')
  assert.equal(rejectUnauthorizedCrossDeviceMigration({ explicitAuthorizedTransfer: true }), null)
})

await check('phone_owner_resolve_never_orders_by_expires_limit_1', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('export async function findActiveDeviceIdForPaymentPhone')
  const end = src.indexOf('export async function isDeviceLinkedToPaymentPhone', start)
  const fn = src.slice(start, end > start ? end : start + 4000)
  assert.doesNotMatch(fn, /ORDER BY ds\.expires_at DESC\s*\n\s*LIMIT 1/)
  assert.match(fn, /ambiguous/)
  assert.match(src, /listActiveDeviceIdsForPaymentPhone/)
  assert.match(src, /resolveUniqueActiveDeviceIdForPaymentPhone/)
})

await check('transfer_request_prefers_own_device_never_guesses_sibling', () => {
  const src = read('src/routes/deviceSecurity.js')
  const start = src.indexOf("deviceSecurityRouter.post('/transfer/request'")
  const end = src.indexOf("deviceSecurityRouter.post(", start + 40)
  const fn = src.slice(start, end > start ? end : start + 5000)
  assert.match(fn, /preferredDeviceId:\s*sourceDeviceId/)
  assert.match(fn, /AMBIGUOUS_PHONE_OWNERSHIP/)
  assert.match(fn, /resolveUniqueActiveDeviceIdForPaymentPhone/)
})

await check('admin_force_phone_requires_explicit_source_when_ambiguous', () => {
  const src = read('src/routes/deviceSecurity.js')
  assert.match(src, /admin-force-phone[\s\S]*AMBIGUOUS_PHONE_OWNERSHIP/)
  assert.match(src, /b\.source_device_id \?\? b\.from_device_id/)
  const inv = read('src/routes/customerInvestigation.js')
  assert.match(inv, /AMBIGUOUS_PHONE_OWNERSHIP/)
  assert.match(inv, /b\.source_device_id \?\? b\.from_device_id/)
})

await check('activation_binds_txn_device_id_only', () => {
  const src = read('src/lib/canonicalPaymentActivation.js')
  assert.match(src, /txn\.device_id/)
  assert.match(src, /device_transfers dt/)
  assert.doesNotMatch(src, /findActiveDeviceIdForPaymentPhone/)
  assert.match(src, /preserve_existing_active/)
})

await check('access_cache_keyed_by_device_id_not_phone', () => {
  const src = read('src/lib/subscriptionAccessCache.js')
  assert.match(src, /cacheKey\(deviceId/)
  assert.doesNotMatch(src, /phone/)
  clearAllSubscriptionAccessCache()
  setCachedSubscriptionAccess('device_A', null, {
    status: 'active',
    active_now: true,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    remaining_seconds: 86400,
    remaining_days: 1,
  })
  setCachedSubscriptionAccess('device_B', null, {
    status: 'active',
    active_now: true,
    expires_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    remaining_seconds: 172800,
    remaining_days: 2,
  })
  const a = getCachedSubscriptionAccess('device_A', null)
  const b = getCachedSubscriptionAccess('device_B', null)
  assert.equal(a?.remaining_days, 1)
  assert.equal(b?.remaining_days, 2)
  invalidateSubscriptionAccessCache('device_A')
  assert.equal(getCachedSubscriptionAccess('device_A', null), undefined)
  assert.equal(getCachedSubscriptionAccess('device_B', null)?.remaining_days, 2)
  clearAllSubscriptionAccessCache()
})

await check('verify_entitlement_summary_device_scoped', () => {
  const src = read('src/billingStore.js')
  const start = src.indexOf('async function buildEntitlementVerifyTxnSummary')
  const end = src.indexOf('\nasync function ', start + 10)
  const fn = src.slice(start, end > start ? end : start + 8000)
  assert.match(fn, /ds\.device_id = \$1/)
  assert.doesNotMatch(fn, /LEFT JOIN LATERAL/)
  assert.doesNotMatch(fn, /tzPhoneCanonicalSql/)
})

await check('audit_device_isolation_script_present', () => {
  const src = read('scripts/audit-device-isolation.mjs')
  assert.match(src, /NEVER changes/)
  assert.match(src, /shared_active_transaction_id/)
  assert.doesNotMatch(src, /SET\s+expires_at\s*=/)
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
