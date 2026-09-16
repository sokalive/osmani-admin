# Production Fix Report: Paid Renewal After Expiry Entitlement Preservation

**Date:** 2026-09-16  
**VPS:** 144.91.117.90  
**Commit:** `cffd61bbd7dbf40d559bc92448355d183929ff01`  
**Deployed:** YES (API `/api/health` commit match)

---

## VERDICT

**PASS**

---

## ROOT CAUSE

`applySonicpesaPaymentOutcome` / shared `updateTransactionByOrderId` did not persist `transactions.completed_at`. Historical entitlement correction credited payments with `COALESCE(completed_at, created_at)`, so delayed post-expiry completions were treated as old `created_at` purchases. Correction then rewrote a valid future `expires_at` to a past date (`expires_at < started_at`) after `ACTIVATED`.

---

## PAYMENT SYSTEM

**CONFIRMED WORKING** — checkout, provider integration, amounts, plans unchanged.

## PAYMENT FLOW CHANGED

**NO** — only completion timestamp persistence on already-authoritative completion transitions.

---

## COMPLETED_AT FIX

- `canonicalPaymentActivation.applySonicpesaPaymentOutcome`: on transition to `completed`, set `completed_at = COALESCE(completed_at, now())`; backfill on already-completed reactivation path.
- `billingStore.updateTransactionByOrderId`: same idempotent stamp (covers ZenoPay / AuraxPay / shared reconcile paths).

---

## HISTORICAL CORRECTION HARDENING

- Shared credit clock: `transactionCreditClock.js` — `completed_at → webhookAt/orderStatusPolledAt → safe updated_at → created_at` (rejects bulk backfill stamp `2026-07-26T19:53:34.846Z`).
- `subscriptionExpiryAudit.loadCreditEvents*` uses the new SQL credit clock.
- `historicalEntitlementCorrection`: align linked payment credit to `started_at` when later; **reject** mutations that would set `expires_at < started_at`.
- `historicalSubscriptionNormalization.paymentEvent` uses the same JS credit resolver.

---

## RENEWAL-AFTER-EXPIRY PROTECTION

Expired prior row does not block activation (upsert on `device_id`). New entitlement uses midnight-EAT from activation/completion clock. Correction can no longer destroy it via stale `created_at`.

Also restored `expiry_policy` on `computeDeviceSubscriptionExpiryAfterPurchase` so preserve-active skip works when already live.

---

## REGRESSION TESTS

| Suite | Result |
|-------|--------|
| `test-paid-renewal-after-expiry.mjs` | PASS |
| `test-historical-entitlement-correction.mjs` | PASS |
| `test-subscription-stacking.mjs` | PASS |

---

## HISTORICAL VICTIMS / REPAIR

| Metric | Value |
|--------|-------|
| Signature candidates | 143 |
| Rejected (insufficient evidence) | 0 |
| Repaired | 143 |
| Skipped | 0 |
| Second audit candidates | **0** |
| Idempotent dry-run would_repair | **0** |

**Backup:** table `paid_renewal_entitlement_restore_backups`  
**Batch:** `1933b420-5ba9-4bbb-836b-78f85d9578d0`

Proven sample `45b0a8a3…`: started 2026-09-15, expires restored **2026-10-14T21:00:00Z**, `active_now: true`, `completed_at` backfilled to activation time.

---

## POST-FIX HISTORICAL AUDIT (read-only, not applied)

| Field | Value |
|-------|--------|
| over_credited | 1 |
| under_credited | 51 |
| repair_candidates | 52 |
| dangerous expires_before_started | **0** |

Remaining repair_candidates are **other** lineage/audit rows at the Sep 15 audit reference — **not** re-applied in this task. Victim signature is cleared.

---

## SAFETY COUNTS

| Check | Result |
|-------|--------|
| OVER_CREDITED (victim path) | N/A — victims restored |
| IMPOSSIBLE EXPIRY STATES (expires&lt;started + ACTIVATED) | **0** |
| SECOND VICTIM AUDIT | repair_candidates = **0** |
| PAYMENT TRANSACTIONS DELETED | **0** |
| PAYMENT HISTORY DELETED | **0** |
| USERS DELETED | **0** |
| NEW FREE TIME ADDED | **0** (only purchased `plan_duration_days` from activation clock) |

---

## GITHUB

- Pushed: `cffd61bbd7dbf40d559bc92448355d183929ff01` → `origin/main` (`sokalive/osmani-admin`)

## DEPLOYMENT

- VPS `144.91.117.90`
- `/api/health` commit `cffd61bb…`, `startup.ready: true`, pool not saturated

## API HEALTH / DATABASE HEALTH

- API: **PASS**
- DB via health pool + device investigation: **PASS**

## PAYMENT PROVIDER / CHECKOUT

- **UNCHANGED**

## REAL PAYMENT TEST

- **NOT YET PERFORMED** (backend validated; controlled test for 0678089174 ready after ops approval)

---

## FILES CHANGED

- `server/src/lib/transactionCreditClock.js` (new)
- `server/src/lib/paidRenewalEntitlementRestore.js` (new)
- `server/src/lib/canonicalPaymentActivation.js`
- `server/src/billingStore.js`
- `server/src/lib/subscriptionExpiryAudit.js`
- `server/src/lib/historicalEntitlementCorrection.js`
- `server/src/lib/historicalSubscriptionNormalization.js`
- `server/src/routes/runtimePublic.js`
- `server/scripts/test-paid-renewal-after-expiry.mjs` (new)
- `server/scripts/test-historical-entitlement-correction.mjs`
- `server/package.json`
- `docs/PAID_RENEWAL_AFTER_EXPIRY_ROOT_CAUSE_INVESTIGATION.md`

---

## HOW THIS PREVENTS RECURRENCE

1. Every genuine completion now stamps `completed_at` once.  
2. Credit replay prefers that stamp (and activation/`started_at`), never a stale order `created_at` when later evidence exists.  
3. Historical correction refuses `expires_at < started_at`.  
4. Dedicated restore path remains available if any legacy rows match the signature.

Flow after fix:

SUCCESSFUL PAYMENT → SUCCESSFUL ACTIVATION → AUTHORITATIVE `completed_at` → CORRECT HISTORICAL DURATION → CORRECT EXPIRY → ENTITLEMENT REMAINS VALID
