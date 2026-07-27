#!/usr/bin/env node
/**
 * Static regression: Hamisha transfer must preserve purchase metadata and guard active codes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMovedSourceTransactionId,
  computeTransferTargetExpiry,
  resolvePreservedTransactionIdForTransfer,
} from '../src/lib/transferSubscriptionMove.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failed = []

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function check(name, fn) {
  try {
    fn()
    console.log('PASS', name)
  } catch (e) {
    failed.push(name)
    console.error('FAIL', name, e.message)
  }
}

check('preserve_payment_transaction_id_on_target', () => {
  const txn = resolvePreservedTransactionIdForTransfer(
    { transaction_id: 'osm_sp_1785049533810_abc' },
    'TR-000001',
  )
  assert.equal(txn, 'osm_sp_1785049533810_abc')
})

check('preserve_manual_grant_transaction_id', () => {
  const txn = resolvePreservedTransactionIdForTransfer({ transaction_id: 'manual_grant:42' }, 'TR-000002')
  assert.equal(txn, 'manual_grant:42')
})

check('moved_marker_on_source_after_transfer', () => {
  const moved = buildMovedSourceTransactionId(
    'a'.repeat(64),
    'osm_sp_1785049533810_abc',
  )
  assert.match(moved, /^moved:[a-f0-9]{64}:osm_sp_/)
})

check('transfer_revokes_source_before_target_assign', () => {
  const src = read('src/lib/transferSubscriptionMove.js')
  const revokeIdx = src.indexOf('revokeSource = await client.query')
  const upsertIdx = src.indexOf('upsertTarget = await client.query')
  assert.ok(revokeIdx > 0 && upsertIdx > revokeIdx, 'source revoke must precede target upsert')
  assert.match(src, /freedSourceTxnId/)
  assert.match(src, /preservedTxnId/)
  assert.match(src, /buildMovedSourceTransactionId/)
})

check('transfer_request_blocks_duplicate_active_code', () => {
  const src = read('src/routes/deviceSecurity.js')
  const fnStart = src.indexOf("deviceSecurityRouter.post('/transfer/request'")
  const fnEnd = src.indexOf("deviceSecurityRouter.post('/transfer/confirm'")
  const fn = src.slice(fnStart, fnEnd)
  assert.match(fn, /findExistingActiveTransferCode/)
  assert.match(fn, /ACTIVE_TRANSFER_EXISTS/)
})

check('verify_resolves_transfer_metadata_from_source', () => {
  const src = read('src/billingStore.js')
  assert.match(src, /getTransferSourceCompletedTransaction/)
})

check('force_transfer_and_hamisha_share_commitSubscriptionTransfer', () => {
  const src = read('src/routes/deviceSecurity.js')
  assert.match(src, /from '\.\.\/lib\/transferSubscriptionMove\.js'/)
  assert.match(src, /commitSubscriptionTransfer/)

  const forceFnStart = src.indexOf('export async function executeAdminForceTransfer')
  const forceFnEnd = src.indexOf('deviceSecurityRouter.get', forceFnStart)
  const forceFn = src.slice(forceFnStart, forceFnEnd > forceFnStart ? forceFnEnd : forceFnStart + 3500)
  assert.match(forceFn, /commitSubscriptionTransfer\(client/)

  const confirmStart = src.indexOf("deviceSecurityRouter.post('/transfer/confirm'")
  const confirmEnd = src.indexOf("deviceSecurityRouter.post('/transfer/respond'")
  const confirmFn = src.slice(confirmStart, confirmEnd)
  assert.match(confirmFn, /commitSubscriptionTransfer\(client/)

  const respondStart = src.indexOf("deviceSecurityRouter.post('/transfer/respond'")
  const respondEnd = src.indexOf("deviceSecurityRouter.get('/transfer/status'")
  const respondFn = src.slice(respondStart, respondEnd)
  assert.match(respondFn, /commitSubscriptionTransfer\(client/)

  const phoneForceStart = src.indexOf("deviceSecurityRouter.post('/transfer/admin-force-phone'")
  const phoneForceFn = src.slice(phoneForceStart, phoneForceStart + 2500)
  assert.match(phoneForceFn, /executeAdminForceTransfer/)
})

check('device_control_page_wires_force_transfer_api', () => {
  const src = read('../src/pages/DeviceControlPage.jsx')
  assert.match(src, /postAdminForceTransferPhone/)
  assert.match(src, /getDeviceControlSettings/)
  assert.match(src, /putDeviceControlSettings/)
  assert.match(src, /const \[forceSubmitting, setForceSubmitting\] = useState\(false\)/)
  assert.match(src, /Settings/)
  assert.match(src, /Recent Activity/)
  assert.match(src, /Force Transfer/)
})

check('target_expiry_is_max_of_source_and_target', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0)
  const srcExp = new Date(Date.UTC(2026, 7, 1, 21, 0, 0))
  const tgtExp = new Date(Date.UTC(2026, 7, 15, 21, 0, 0))
  const out = computeTransferTargetExpiry(srcExp, tgtExp, new Date(now))
  assert.equal(out.toISOString(), tgtExp.toISOString())
})

console.log(`\n=== regression-transfer-subscription (${failed.length} failures) ===\n`)
process.exit(failed.length ? 1 : 0)
