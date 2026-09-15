# OSMANI TV — Subscription Expiry / Activation System Report

Generated: 2026-09-15

## VERDICT

**PASS WITH LIMITATIONS**

Runtime entitlement contract is implemented and verified. Observational audit replay was aligned to no-stack policy in this deploy. Production retains 3 legacy over-credited rows and 44 under-credited rows from pre-hardening stacking/manual grants — repair paths remain legacy-locked (observational only).

---

## BEFORE

- Core canonical engine already present on main (`canonicalPaymentActivation`, `subscriptionStacking`, `subscriptionEntitlementGuard`, `subscriptionAccessCache`, `activeSubscriptionPaymentGate`).
- Activation only after completed payment via single `activateFromCompletedTxn` path.
- Midnight EAT expiry, no stacking at runtime, 409 gate at order creation.
- **Gap found:** `subscriptionExpiryAudit.js` replay still used legacy stacking math and live `plans.duration_days` instead of snapshotted `transactions.plan_duration_days`.
- **Gap found:** Audit API `extension_policy_detail` text incorrectly described stacking renewals.
- **Gap found:** `verify-subscription-expiry-production.mjs` expected deprecated 22-day stacking behavior.

---

## ROOT CAUSE

1. Observational audit replay lagged behind runtime hardening — still replayed historical stacking extension instead of `preserve_existing_active`.
2. Audit credit-event SQL joined live plan duration, not purchase-time snapshot.
3. Production verification script not updated when stacking was permanently disabled (e8a7a88 / c625d00 era).

Runtime verify/access paths were already authoritative on `expires_at > now()`.

---

## AFTER

- Audit replay uses `computeStackedExpiryIso` (no-stack, preserve existing active).
- All audit transaction loaders use `COALESCE(NULLIF(t.plan_duration_days,0), p.duration_days)`.
- Policy detail documents 409 gate + midnight EAT + snapshot semantics.
- New deterministic contract test suite: `server/scripts/test-subscription-expiry-contract.mjs`.
- Production verification script updated for no-stack policy and live plan durations.

---

## CANONICAL EXPIRY CONTRACT

| Rule | Implementation |
|------|----------------|
| SoT | `device_subscriptions.expires_at` |
| Active-now | `status='active' AND expires_at > now() AND admin_revoked_at IS NULL` |
| Expiry calc | Purchase EAT calendar date + `duration_days` at 00:00 `Africa/Dar_es_Salaam` |
| Snapshot | `transactions.plan_duration_days` frozen at `insertTransaction` |
| Activation | Only via `activateFromCompletedTxn` after `status='completed'` |
| No stacking | 409 at checkout; activation preserves existing active expiry |
| Enforcement | SQL `expires_at > now()` on verify/access — no cron required |
| Capacity | Verify returns `active:null` / 503 on pool pressure — never `active:false` |

---

## ACTIVATION FLOW

```
Order create (pending) → payment webhook/poll/verify/reconcile
  → applySonicpesaPaymentOutcome / activateFromCompletedTxn
  → computeDeviceSubscriptionExpiryAfterPurchase (snapshot duration)
  → assertWritableEntitlement (Entitlement Guard)
  → upsertDeviceSubscriptionActive (idempotent by transaction_id)
  → cache invalidate + SSE + SMS after COMMIT
```

Callers: SonicPesa webhook, order status poll, app verify reconcile, admin recovery, stale pending reconcile.

---

## NO-STACKING

- `assertNoActiveSubscriptionForPayment` on SonicPesa/AuraxPay/ZenoPay create-order → HTTP 409 `ACTIVE_SUBSCRIPTION_EXISTS`.
- `computeStackedExpiryIso`: `preserve_existing_active` when previous future expiry exists.
- Duplicate webhooks: `deviceSubscriptionOrderAlreadyApplied` + `ALREADY_APPLIED`.

---

## CACHE SAFETY

- `subscriptionAccessCache`: TTL bounded (3s default / 8s active).
- Stale restore permanently disabled.
- Cache hit with `active_now` + passed `expires_at` → miss (DB refresh).
- Writers invalidate on activation/revoke/transfer.

---

## CAPACITY/TRANSPORT SAFETY

- `verifyDbResilience.js`: pool saturation / timeout → 503, `active:null`, `retryable:true`.
- Last-resort active fallback only when DB confirms active entitlement.

---

## ADMIN PARITY

- Active: `expires_at > now()`
- Expired: `status='active' AND expires_at <= now() AND admin_revoked_at IS NULL`
- Revoked: `admin_revoked_at` → status `revoked`, not `expired`
- `mapOperationalSubscriptionRow` uses same semantics

---

## TIMEZONE

- `SUBSCRIPTION_TZ = Africa/Dar_es_Salaam` (UTC+3, no DST)
- Example: 2026-08-01 00:00 EAT → `2026-07-31T21:00:00.000Z`

---

## TEST RESULTS

| Suite | Result |
|-------|--------|
| test-subscription-expiry-contract.mjs | 15/15 PASS |
| test-subscription-stacking.mjs | PASS |
| test-subscription-verify-unavailable.mjs | PASS |
| regression-subscription-hardening.mjs | 12/12 PASS |
| test-admin-expired-subscriptions.mjs | 12/13 (live admin session skip) |
| verify-subscription-expiry-production.mjs | PASS (read-only prod) |

---

## PRODUCTION VERIFICATION

- Health: `https://api.osmanitv.com/api/health` → ok, commit pre-deploy `eb9de0a`
- Plans: Wiki 1 8d/3000, MWENZI 1 30d/5000, MIEZI 2 60d/15000, MIEZI 4 121d/30000
- Expiry audit: 1435 users, over_credited=3 (legacy), under_credited=44 (legacy stacked entitlements)
- PM2 pool: 8/60 connections, not saturated

---

## FILES CHANGED

- `server/src/lib/subscriptionExpiryAudit.js`
- `server/scripts/test-subscription-expiry-contract.mjs` (new)
- `server/scripts/verify-subscription-expiry-production.mjs`
- `docs/SUBSCRIPTION_EXPIRY_ACTIVATION_FINAL_REPORT.md` (this file)

---

## GITHUB COMMIT

`7a3217e532510a711b6c15d50f6f50141726b3af`

---

## VPS DEPLOYMENT

144.91.117.90 — deployed via GitHub Actions `contabo-deploy.yml` (push to main). Health confirms commit `7a3217e`.

---

## PM2/API HEALTH

Post-deploy (2026-09-15T06:44Z):

```json
{"ok":true,"commit":"7a3217e532510a711b6c15d50f6f50141726b3af","pool":{"totalCount":3,"idleCount":2,"waitingCount":0,"max":60,"saturated":false}}
```

Expiry audit policy text updated on production. Replay steps show `preserved_existing: true`, `stacked: false`.

---

## DATABASE CHANGES

None. Read-only audit queries only.

---

## PAYMENT CHANGES

None.

---

## UNRESOLVED ITEMS

1. Three production over-credited legacy subscriptions — repair locked by design; observational only.
2. Forty-four under-credited rows reflect pre-hardening stacked entitlements — customers retain higher expiry (no clawback).
3. Admin `/users/summary` requires session auth (not token-only) for live census cross-check.
