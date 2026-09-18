# Package Catalog Snapshot Isolation Fix

**Date:** 2026-09-18  
**VPS:** 144.91.117.90  
**Scope:** CODE-ONLY — no user subscription / transaction mutations

## VERDICT

**PASS**

## ROOT CAUSE

Existing entitlements already store baked `expires_at` and transactions already snapshot `amount` + `plan_duration_days` at purchase time.

Admin/API **display** joins ignored `transactions.plan_duration_days` and used live `plans.duration_days` (and live price when amount missing). Catalog edits therefore made historical packages *look* like today’s price/duration without changing `expires_at`.

## EXACT FIX

Prefer historical snapshot fields everywhere user-facing historical terms are read:

`COALESCE(NULLIF(txn.plan_duration_days, 0), grant.duration_days, plans.duration_days)`  
`COALESCE(txn.amount, plans.price)`

Live catalog remains fallback for legacy NULL snapshots only, and for **new** purchases (unchanged create-order paths).

## FILES CHANGED

- `server/src/lib/packagePurchaseSnapshot.js` (new)
- `server/src/lib/adminUsersList.js`
- `server/src/lib/paymentOrderLedger.js`
- `server/src/billingStore.js` (`listDeviceUsers` + verify summary guard)
- `server/scripts/test-package-catalog-snapshot-isolation.mjs` (new)
- `server/package.json`

## SAFETY CONFIRMATIONS

| Item | Result |
|------|--------|
| Existing user subscription rows modified | **NO** |
| Transactions modified | **NO** |
| Payment code / SonicPesa / checkout modified | **NO** |
| expires_at / started_at / status changed | **NO** |
| Mobile app / OTA | **NO** |

## HISTORICAL PRICE / DURATION

- Price: `transactions.amount` (authoritative paid amount)
- Duration: `transactions.plan_duration_days` (then grant duration, then live legacy fallback)

## NEW PURCHASE / EXPIRED RENEWAL

Unchanged: order creation still snapshots current catalog into the new transaction. Old entitlement rows untouched.

## TESTS

All CASE 1–10 in `test-package-catalog-snapshot-isolation.mjs`: **PASS**  
Paid-renewal / historical-correction / stacking regressions: **PASS**

## SAFETY STATEMENT

Existing user entitlements were not retroactively changed by this fix. The fix prevents the current package catalog from changing historical purchase terms. New catalog values apply only to new purchases/activations.
