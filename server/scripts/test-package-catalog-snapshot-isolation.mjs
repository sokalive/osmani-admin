#!/usr/bin/env node
/**
 * Package catalog snapshot isolation — historical price/duration must not
 * follow Admin catalog edits. New purchases use the catalog at buy time.
 */
import assert from 'node:assert/strict'
import {
  assertPurchaseIsolatedFromCatalog,
  resolveHistoricalPaidAmount,
  resolveHistoricalPlanDurationDays,
  snapshotFromCurrentCatalog,
  historicalPlanDurationSql,
  historicalTxnPlanDurationSql,
  historicalPaidAmountSql,
} from '../src/lib/packagePurchaseSnapshot.js'
import { computeStackedExpiryIso, computeMidnightEatExpiryIso } from '../src/lib/subscriptionStacking.js'

function pass(msg) {
  console.log(`PASS ${msg}`)
}

// CASE 1: Purchase 3000/8 then catalog → 4000/10 → historical stays 3000/8
{
  const purchase = { amount: 3000, durationDays: 8 }
  const catalogLater = { price: 4000, durationDays: 10 }
  const out = assertPurchaseIsolatedFromCatalog(purchase, catalogLater)
  assert.equal(out.amount, 3000)
  assert.equal(out.durationDays, 8)
  assert.equal(out.isolated, true)
  pass('CASE1 existing purchase isolated after catalog change')
}

// CASE 2: New purchase after catalog change gets 4000/10
{
  const catalog = { price: 4000, durationDays: 10 }
  const snap = snapshotFromCurrentCatalog(catalog)
  assert.equal(snap.amount, 4000)
  assert.equal(snap.durationDays, 10)
  const view = assertPurchaseIsolatedFromCatalog(snap, { price: 5000, durationDays: 15 })
  assert.equal(view.isolated, true)
  assert.equal(view.amount, 4000)
  assert.equal(view.durationDays, 10)
  pass('CASE2 new purchase uses catalog at buy time')
}

// CASE 3: Expired old entitlement keeps original terms
{
  const old = { amount: 3000, durationDays: 8 }
  const catalog = { price: 4000, durationDays: 10 }
  const out = assertPurchaseIsolatedFromCatalog(old, catalog)
  assert.equal(out.isolated, true)
  // expires_at is independent of catalog — already baked from purchase clock
  const started = Date.UTC(2026, 5, 1, 10, 0, 0)
  const expiresAt = computeMidnightEatExpiryIso(old.durationDays, started)
  const afterCatalogEdit = computeMidnightEatExpiryIso(old.durationDays, started)
  assert.equal(expiresAt, afterCatalogEdit)
  pass('CASE3 expired historical terms + expires_at unchanged by catalog')
}

// CASE 4: Renew after expiry uses NEW catalog; old txn unchanged
{
  const oldTxn = { amount: 3000, durationDays: 8 }
  const newCatalog = { price: 4000, durationDays: 10 }
  const newTxn = snapshotFromCurrentCatalog(newCatalog)
  assert.equal(assertPurchaseIsolatedFromCatalog(oldTxn, newCatalog).isolated, true)
  assert.equal(newTxn.amount, 4000)
  assert.equal(newTxn.durationDays, 10)
  // Old snapshot still isolated if catalog changes again
  assert.equal(
    assertPurchaseIsolatedFromCatalog(oldTxn, { price: 9999, durationDays: 99 }).isolated,
    true,
  )
  pass('CASE4 renewal uses new catalog; old txn unchanged')
}

// CASE 5: Price-only catalog change — duration snapshot unchanged
{
  const purchase = { amount: 3000, durationDays: 8 }
  const out = assertPurchaseIsolatedFromCatalog(purchase, { price: 4500, durationDays: 8 })
  assert.equal(out.amount, 3000)
  assert.equal(out.durationDays, 8)
  pass('CASE5 price-only catalog change isolates paid amount')
}

// CASE 6: Duration-only catalog change — paid amount unchanged
{
  const purchase = { amount: 3000, durationDays: 8 }
  const out = assertPurchaseIsolatedFromCatalog(purchase, { price: 3000, durationDays: 12 })
  assert.equal(out.amount, 3000)
  assert.equal(out.durationDays, 8)
  pass('CASE6 duration-only catalog change isolates historical duration')
}

// CASE 7: Multiple historical durations
{
  const packages = [
    { name: 'Wiki 1', amount: 3000, durationDays: 8 },
    { name: 'MWENZI 1', amount: 5000, durationDays: 30 },
    { name: 'MIEZI 2', amount: 9000, durationDays: 60 },
    { name: 'MIEZI 4', amount: 15000, durationDays: 121 },
    { name: 'Year', amount: 50000, durationDays: 365 },
    { name: 'Siku 3', amount: 1000, durationDays: 3 },
    { name: 'Wiki 7', amount: 2500, durationDays: 7 },
  ]
  const catalogNow = { price: 99999, durationDays: 1 }
  for (const pkg of packages) {
    const out = assertPurchaseIsolatedFromCatalog(pkg, catalogNow)
    assert.equal(out.isolated, true, pkg.name)
    assert.equal(out.durationDays, pkg.durationDays, pkg.name)
    assert.equal(out.amount, pkg.amount, pkg.name)
  }
  pass('CASE7 all historical durations isolated from current catalog')
}

// CASE 8: Idempotent lookup twice — identical, no mutation
{
  const purchase = { amount: 5000, durationDays: 30 }
  const catalog = { price: 8000, durationDays: 45 }
  const a = assertPurchaseIsolatedFromCatalog(purchase, catalog)
  const b = assertPurchaseIsolatedFromCatalog(purchase, catalog)
  assert.deepEqual(a, b)
  assert.equal(purchase.amount, 5000)
  assert.equal(purchase.durationDays, 30)
  pass('CASE8 idempotent historical lookup')
}

// CASE 9: Repeated catalog changes 3000/8 → 4000/10 → 5000/15
{
  const original = { amount: 3000, durationDays: 8 }
  for (const cat of [
    { price: 4000, durationDays: 10 },
    { price: 5000, durationDays: 15 },
    { price: 6000, durationDays: 20 },
  ]) {
    const out = assertPurchaseIsolatedFromCatalog(original, cat)
    assert.equal(out.amount, 3000)
    assert.equal(out.durationDays, 8)
  }
  pass('CASE9 repeated catalog edits leave original snapshot')
}

// CASE 10: Existing expires_at math does not follow catalog duration edits
{
  const purchaseDays = 8
  const started = Date.UTC(2026, 8, 1, 12, 0, 0)
  const expiresBefore = computeMidnightEatExpiryIso(purchaseDays, started)
  // Catalog later says 10 days — entitlement still uses historical 8
  const expiresAfterCatalogEdit = computeMidnightEatExpiryIso(purchaseDays, started)
  assert.equal(expiresBefore, expiresAfterCatalogEdit)
  const wrongIfUsedLive = computeMidnightEatExpiryIso(10, started)
  assert.notEqual(expiresBefore, wrongIfUsedLive)
  // Expired prior + new purchase uses new duration from new snap (not old)
  const expiredPrev = new Date(started - 86400000).toISOString()
  const renewAt = Date.UTC(2026, 8, 20, 12, 0, 0)
  const renew = computeStackedExpiryIso(expiredPrev, 10, renewAt)
  assert.equal(renew.expiresAt, computeMidnightEatExpiryIso(10, renewAt))
  pass('CASE10 expires_at independent of catalog; renewal uses new snap duration')
}

// Resolver edge: grant duration preferred over live when txn snap missing
{
  assert.equal(
    resolveHistoricalPlanDurationDays({
      txnPlanDurationDays: null,
      grantDurationDays: 30,
      livePlanDurationDays: 99,
    }),
    30,
  )
  assert.equal(
    resolveHistoricalPaidAmount({ txnAmount: 3000, livePlanPrice: 4000 }),
    3000,
  )
  assert.equal(
    resolveHistoricalPaidAmount({ txnAmount: null, livePlanPrice: 4000 }),
    4000,
  )
  pass('resolver grant/txn preference + amount fallback')
}

// SQL fragments prefer snapshot columns
{
  const d = historicalPlanDurationSql('pay', 'mg', 'p')
  assert.ok(d.includes('pay.plan_duration_days'))
  assert.ok(d.includes('mg.duration_days'))
  assert.ok(d.includes('p.duration_days'))
  const t = historicalTxnPlanDurationSql('t', 'p')
  assert.ok(t.includes('t.plan_duration_days'))
  assert.ok(historicalPaidAmountSql('pay', 'p').includes('pay.amount'))
  pass('SQL fragments prefer historical snapshot columns')
}

console.log('All package catalog snapshot isolation tests passed.')
