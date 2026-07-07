#!/usr/bin/env node
/**
 * Subscription immutability + UI truth policy regression (static + optional DB).
 * Run: node server/scripts/test-subscription-immutability-policy.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RECOVERY_CLASS,
  classifyPaymentOrderRecovery,
  mapOwnerFacingRecovery,
  parseMovedTransactionId,
} from '../src/lib/paymentOrderRecoveryClassifier.js'
import {
  isAutomaticCrossDeviceMigrationBlocked,
  rejectUnauthorizedCrossDeviceMigration,
  UNAUTHORIZED_MIGRATION_REASON,
} from '../src/lib/subscriptionEntitlementPolicy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

// --- Policy module ---
assert('automatic migration blocked by default', isAutomaticCrossDeviceMigrationBlocked() === true)
assert(
  'unauthorized migration rejected',
  rejectUnauthorizedCrossDeviceMigration()?.reason === UNAUTHORIZED_MIGRATION_REASON,
)
assert(
  'explicit authorized transfer allowed',
  rejectUnauthorizedCrossDeviceMigration({ explicitAuthorizedTransfer: true }) === null,
)

// --- Payment Orders owner display ---
{
  const row = {
    order_id: 'osm_sp_test_order',
    status: 'completed',
    sub_transaction_id: 'moved:abc123def4567890123456789012345678901234567890123456789012345678:osm_sp_test_order',
    sub_status: 'pending',
    sub_expires_at: new Date(Date.now() + 86400000).toISOString(),
  }
  const classified = classifyPaymentOrderRecovery(row)
  assert('classifier still detects SYSTEM_MIGRATION', classified.recoveryClass === RECOVERY_CLASS.SYSTEM_MIGRATION)
  const owner = mapOwnerFacingRecovery(classified)
  assert('owner label is Already Active', owner.recoveryLabel === 'Already Active')
  assert('owner hint is Already Active', owner.recoveryHint === 'Already Active')
  assert('diagnostic class preserved', owner.recoveryDiagnosticClass === RECOVERY_CLASS.SYSTEM_MIGRATION)
  assert('owner label never System Migration', owner.recoveryLabel !== 'System Migration')
}

// --- moved:* parsing ---
{
  const orderId = 'osm_sp_1783367765912_cf6e55550d'
  const dev = 'e157256c1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab'
  const parsed = parseMovedTransactionId(`moved:${dev}:${orderId}`)
  assert('moved parser extracts order', parsed.isMoved && parsed.embeddedTransactionId === orderId)
}

// --- Static source guards ---
const recoverySrc = fs.readFileSync(path.join(__dirname, '../src/lib/subscriptionRecovery.js'), 'utf8')
const policySrc = fs.readFileSync(path.join(__dirname, '../src/lib/subscriptionEntitlementPolicy.js'), 'utf8')
const adminSrc = fs.readFileSync(path.join(__dirname, '../src/lib/adminUsersList.js'), 'utf8')
const ledgerSrc = fs.readFileSync(path.join(__dirname, '../src/lib/paymentOrderLedger.js'), 'utf8')
const deviceSecSrc = fs.readFileSync(path.join(__dirname, '../src/routes/deviceSecurity.js'), 'utf8')

assert('recovery imports policy guard', recoverySrc.includes('subscriptionEntitlementPolicy'))
assert('ensureSubscriptionLinked blocks auto migration', recoverySrc.includes('rejectUnauthorizedCrossDeviceMigration()'))
assert('migrate guarded', recoverySrc.includes('rejectUnauthorizedCrossDeviceMigration(opts)'))
assert('adminUsersList no zenopay provider default', !adminSrc.includes("', 'zenopay')"))
assert('adminUsersList uses unknown fallback', adminSrc.includes("'unknown')"))
assert('adminUsersList moved_pay join', adminSrc.includes('moved_pay'))
assert('adminUsersList historical status', adminSrc.includes("'historical'"))
assert('ledger uses mapOwnerFacingRecovery', ledgerSrc.includes('mapOwnerFacingRecovery'))
assert('deviceSecurity recover blocks auto', deviceSecSrc.includes('Automatic cross-device subscription recovery is disabled'))

// --- Optional DB: no migration on verify paths ---
async function runDbTests() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP DB immutability tests — DATABASE_URL not set')
    return
  }

  const crypto = await import('node:crypto')
  const { getPool } = await import('../src/db/pool.js')
  const billing = await import('../src/billingStore.js')
  const { tryFastFingerprintRecovery, ensureSubscriptionLinkedForDevice, migrateSubscriptionFromSourceDevice } =
    await import('../src/lib/subscriptionRecovery.js')

  await billing.ensureBillingStorage()
  const pool = getPool()
  const phone = `2557${String(Date.now()).slice(-8)}`
  const fp = `fp-test-${crypto.randomBytes(8).toString('hex')}`
  const fpHash = billing.hashDeviceFingerprint(fp)
  const deviceA = crypto.randomBytes(32).toString('hex')
  const deviceB = crypto.randomBytes(32).toString('hex')
  const orderA = `immut_test_a_${Date.now()}`
  const expires = new Date(Date.now() + 7 * 86400000).toISOString()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, $4)
       ON CONFLICT (device_id) DO UPDATE SET status = 'active', expires_at = EXCLUDED.expires_at, transaction_id = EXCLUDED.transaction_id, fingerprint_hash = EXCLUDED.fingerprint_hash`,
      [deviceA, expires, orderA, fpHash],
    )
    await client.query(
      `INSERT INTO transactions (order_id, device_id, phone, status, amount, plan_id, created_at, updated_at, raw_payload)
       VALUES ($1, $2, $3::bigint, 'completed', 1000, 3, now(), now(), $4::jsonb)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderA, deviceA, phone, JSON.stringify({ payment_provider: 'sonicpesa' })],
    )
    await client.query('COMMIT')

    const fast = await tryFastFingerprintRecovery(deviceB, fp)
    assert('fingerprint recovery blocked on device B', fast.linked === false && fast.reason === UNAUTHORIZED_MIGRATION_REASON)

    const link = await ensureSubscriptionLinkedForDevice(deviceB, { fingerprint: fp, phone })
    assert('ensureSubscriptionLinked blocked', link.linked === false && link.reason === UNAUTHORIZED_MIGRATION_REASON)

    const mig = await migrateSubscriptionFromSourceDevice(deviceB, deviceA)
    assert('migrateSubscriptionFromSourceDevice blocked', mig.recovered === false && mig.reason === UNAUTHORIZED_MIGRATION_REASON)

    const { rows: afterA } = await pool.query(
      `SELECT status, transaction_id FROM device_subscriptions WHERE device_id = $1`,
      [deviceA],
    )
    assert('device A still active after blocked attempts', afterA[0]?.status === 'active' && afterA[0]?.transaction_id === orderA)

    const { rows: afterB } = await pool.query(`SELECT device_id FROM device_subscriptions WHERE device_id = $1`, [deviceB])
    assert('device B has no stolen subscription', afterB.length === 0)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await pool.query('DELETE FROM transactions WHERE order_id LIKE $1', [`immut_test_%`]).catch(() => {})
    await pool.query('DELETE FROM device_subscriptions WHERE device_id IN ($1, $2)', [deviceA, deviceB]).catch(() => {})
    client.release()
    await pool.end().catch(() => {})
  }
}

await runDbTests()

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exit(1)
