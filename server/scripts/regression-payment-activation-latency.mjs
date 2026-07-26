/**
 * Permanent regression: payment activation latency floors.
 * Deploy fails if the post-payment poll ladder or reconcile queue regresses
 * back to coarse 45s/60s/15s gaps that caused ~1 minute "Inaanzisha" waits.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

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

function readSrc(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

check('boost_ladder_has_no_45s_or_60s_early_gap', () => {
  const src = readSrc('src/lib/paymentActivationBoost.js')
  // Default string must not include the historical coarse ticks that caused ~1 min waits.
  assert.equal(src.includes('45000,60000'), false, 'must not ship 45s,60s consecutive early gaps')
  assert.equal(src.includes('90000,120000,180000,240000,300000,360000'), false)
  // Must keep a dense sub-second / few-second early window.
  assert.match(src, /0,\s*400,\s*900/)
})

check('boost_first_nonzero_tick_under_1s', () => {
  const src = readSrc('src/lib/paymentActivationBoost.js')
  const m = src.match(/'0,([^']+)'/)
  assert.ok(m, 'default poll string present')
  const delays = m[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
  assert.ok(delays[0] <= 500, `first follow-up tick must be ≤500ms, got ${delays[0]}`)
  // Within first 10 seconds there must be at least 4 polls.
  const early = delays.filter((d) => d > 0 && d <= 10_000)
  assert.ok(early.length >= 4, `need ≥4 polls in first 10s, got ${early.length}`)
})

check('reconcile_queue_default_under_8s', () => {
  const src = readSrc('src/lib/sonicpesaPaymentReconciliationQueue.js')
  assert.match(src, /SONICPESA_RECONCILE_QUEUE_MS\)\s*\|\|\s*5_000/)
  assert.match(src, /Math\.max\(3_000/)
  assert.equal(/Math\.max\(8_000/.test(src), false, '8s floor must not return')
})

check('inbox_worker_default_2s', () => {
  const src = readSrc('src/lib/sonicpesaWebhookWorker.js')
  assert.match(src, /SONICPESA_INBOX_WORKER_MS\)\s*\|\|\s*2_000/)
})

check('sonicpesa_webhook_sync_process_default_on', () => {
  const src = readSrc('src/lib/payments/providers/sonicpesa.js')
  assert.match(src, /SONICPESA_WEBHOOK_SYNC_PROCESS\s*!==\s*'0'/)
})

check('apply_outcome_notifies_after_commit', () => {
  const src = readSrc('src/lib/canonicalPaymentActivation.js')
  assert.match(src, /await client\.query\('COMMIT'\)[\s\S]*notifySubscriptionActivatedFromAct/)
})

check('txn_duration_snapshot_column_and_insert', () => {
  const tables = readSrc('src/db/billingTables.js')
  assert.match(tables, /plan_duration_days INTEGER/)
  const store = readSrc('src/billingStore.js')
  assert.match(store, /plan_duration_days/)
  const act = readSrc('src/lib/canonicalPaymentActivation.js')
  assert.match(act, /txn\.plan_duration_days/)
})

check('admin_grant_route_requires_plan_id', () => {
  const src = readSrc('src/routes/manualSubscriptionAdmin.js')
  assert.match(src, /plan_id is required/)
  const offer = readSrc('src/routes/offerCodesAdmin.js')
  assert.match(offer, /plan_id is required/)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== payment activation latency / plan snapshot regression ===')
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
process.exit(failed.length ? 1 : 0)
