# Forensic Investigation: Paid Renewal After Expiry → No New Entitlement

**Project:** Osmani TV Admin / Backend only  
**VPS:** 144.91.117.90  
**Investigated (read-only):** 2026-09-16  
**Live commit at investigation:** `a8ff82bc2e6e…`  
**Scope:** Investigation only — no code, DB, env, provider, webhook, or deploy changes.

---

## VERDICT

**ROOT CAUSE IDENTIFIED**

---

## BUG SCOPE

Exact scenario:

1. Prior package expires (or customer otherwise has no live entitlement).
2. Customer pays successfully (often via a **stale pending** SonicPesa order completed later by `order_status_poll`).
3. Backend marks transaction `completed` and **activation succeeds** (`activation_state: ACTIVATED`).
4. `device_subscriptions` is upserted with matching `transaction_id`, `status = active`, and a **future** `expires_at` (from `Date.now()` + plan duration, midnight EAT).
5. Historical entitlement correction (batch apply ~`2026-09-15T08:27:58.905Z`) **rewrites `expires_at` backward** using credit time = `COALESCE(transactions.completed_at, transactions.created_at)`.
6. Because SonicPesa completion **never sets `completed_at`**, credit time falls back to **order `created_at`** (often days/weeks earlier).
7. Replayed canonical expiry is already in the past → correction sets `expires_at` to that past date.
8. Admin/API correctly treat entitlement as inactive (`status=active` AND `expires_at > now()` fails).

Result visible to ops/customers:

**PAYMENT SUCCESS + TRANSACTION COMPLETED + NO ACTIVE PACKAGE**

---

## CONFIRMED EXAMPLES

**Deep-traced: 5** (full device investigation)  
**30-day audit sample matching same pattern (txn linked, status active, expires past): 14**  
**Additional live devices that current correction audit would still shorten from future→past if re-applied: 78** (do not re-run)

Secondary, distinct pattern (not the same root cause): **MOVED_TO_SIBLING_DEVICE** skips activation on transfer-source (`moved:*`) devices — many of the broad “completed without active match” samples.

---

## REQUIRED ANSWERS (1–15)

| # | Question | Answer |
|---|----------|--------|
| 1 | Is payment actually succeeding? | **YES** (provider success → txn `status=completed`) |
| 2 | Does transaction become completed? | **YES** |
| 3 | Does activation run? | **YES** (`ACTIVATED` in `raw_payload.activation_result`) |
| 4 | If activation runs, does it fail? | **NO** — activation succeeds at grant time |
| 5 | If it fails, why? | N/A for primary path; grant is later **overwritten** |
| 6 | If activation does not run, why? | Secondary path only: `MOVED_TO_SIBLING_DEVICE` / admin-revoke block |
| 7 | Does expired previous subscription trigger the bug? | **Indirectly YES** — expired customers commonly complete **old pending orders** long after `created_at`, maximizing `created_at` vs real payment gap that breaks correction |
| 8 | Exact code/query causing failure | See ROOT CAUSE below |
| 9 | Layer? | **Activation OK; failure is post-activation entitlement correction + missing `completed_at`**, not checkout/provider |
| 10 | Why specifically after expiry? | Late completion of orders created while/after lapse; correction anchors duration to create time → past expiry |
| 11 | Same flow without prior expired row? | Fresh devices / timely completions can still activate correctly; correction damage is worst when `created_at ≪` real completion |
| 12 | Historical production examples? | ≥5 proven; ≥14 in 30d sample; dozens more in correction-candidate set |
| 13 | Paid successfully but never received entitlement? | **Yes — received then lost** (expires rewritten past); plus MOVED skips |
| 14 | Money/payment history preserved? | **YES** — transactions remain `completed` |
| 15 | Safest minimal fix? | Description only — see RECOMMENDED MINIMAL FIX (do not implement in this task) |

---

## FAILURE POINT

**Post-activation historical entitlement correction overwrite**, caused by:

1. `applySonicpesaPaymentOutcome` never persisting `transactions.completed_at`
2. Credit replay using `COALESCE(completed_at, created_at)` → wrong anchor
3. Correction mutating `device_subscriptions.expires_at` to a past “canonical” value

**Not** payment provider failure.  
**Not** Admin display/cache alone (PostgreSQL itself has past `expires_at`).  
**Not** duplicate-txn idempotency blocking the new order (new `order_id` was applied).

---

## ROOT CAUSE

### A. Missing `completed_at` on payment completion (long-standing)

`applySonicpesaPaymentOutcome` updates:

- `status = 'completed'`
- `updated_at = now()`
- `raw_payload` / `external_id`

It does **not** set `transactions.completed_at`.

Production evidence (all deep examples): `completed_at: null` while `status: completed` and `updated_at` = real completion time.

### B. Activation path works for expired renewals

`activateFromCompletedTxn` → `computeDeviceSubscriptionExpiryAfterPurchase` → `upsertDeviceSubscriptionActive`:

- For expired prior `expires_at`, stacking policy computes fresh midnight-EAT expiry from **now**
- Entitlement Guard rejects writing past expiry at activation time
- Deep examples show `activation_state: ACTIVATED` and `started_at` ≈ payment completion

Note: `computeDeviceSubscriptionExpiryAfterPurchase` omits returning `expiry_policy`, so the JS `preserve_existing_active` early-return in `activateFromCompletedTxn` is currently **dead**; SQL still preserves `transaction_id` when expiry unchanged. That is **not** the primary failure for expired renewals.

### C. Historical correction used the wrong credit clock (Sep 15 apply)

`loadCreditEventsForDevices` / `loadCreditEventsForDevice`:

```sql
COALESCE(t.completed_at, t.created_at) AS credited_at
```

With null `completed_at`, credit time = order **created_at**.

`historicalEntitlementCorrection` then classifies future live expiry vs past canonical as `EXPIRED` / over-credit and applies `correct_to_expired_canonical` / shorten mutations.

All five deep victims share identical subscription `updated_at = 2026-09-15T08:27:58.905Z` (batch stamp), with:

- `started_at` = late completion (Sep 14–15)
- `expires_at` = `created_at + plan_duration_days` at midnight EAT (**before** `started_at`)
- Impossible under activation Guard alone → proves post-activation overwrite

### D. Why Admin shows “no package”

Canonical active rule: `status = active` AND `expires_at > now()` AND not admin-revoked.

After overwrite: row exists, txn linked, but `expires_at` past → `active_now: false`.

---

## EXPIRED-SUBSCRIPTION CONNECTION

**Proven relationship (indirect, mechanistic):**

- Expired customers are allowed to checkout (active gate blocks only while live).
- They often complete **stale pending** orders (`order_status_poll`) long after create.
- That maximizes `created_at` ≪ real payment success.
- Correction then treats the successful renewal as an old purchase whose duration already ended.

The expired **row** itself does not skip activation. Activation runs. The bug destroys the new entitlement afterward.

---

## PAYMENT SYSTEM

**Functioning for money movement and completion.**

SonicPesa checkout / webhook / poll can complete orders and invoke activation successfully. The payment system is **not** the primary broken layer for this scenario.

---

## DATABASE

- `device_subscriptions` is **one row per `device_id`** (`ON CONFLICT (device_id) DO UPDATE`) — expired row does not block insert; it is updated.
- Unique `transaction_id` idempotency correctly allows a **new** order.
- No evidence that unique constraints prevent creating the new entitlement for these examples.
- After bug: entitlement row present but with **past** `expires_at`.

---

## WEBHOOK / RECONCILIATION

For deep examples, completion source is typically **`order_status_poll`** (stale pending reconcile), not necessarily live webhook.

- Payment marked completed: YES  
- Activation invoked: YES (`ACTIVATED`)  
- Webhook “success before activation” is **not** the failure mode here — activation already succeeded before correction

---

## ACTIVATION

| Step | Result |
|------|--------|
| Attempt | YES |
| Success at grant time | YES (`ACTIVATED`) |
| Entitlement durable | NO — overwritten by historical correction |
| Secondary skip | `MOVED_TO_SIBLING_DEVICE` on `moved:*` source devices |

---

## CACHE / API

**Not a cache-only bug.**

Device investigation shows PostgreSQL `expires_at` already past; access state `active_now: false` matches DB. Admin UI is consistent with DB.

---

## HISTORICAL EXAMPLES (EVIDENCE CHAINS)

### Example 1 — MWENZI 1 (30d), stale Aug order completed Sep 15

| Field | Value |
|-------|--------|
| Device (prefix) | `45b0a8a3de22…` |
| Phone (masked) | `+255628…` |
| Old package | MWENZI 1 — expired ~2026-07-13 (SMS expired) |
| New order | `osm_sp_1786176629413_0e491690d1` |
| Order created_at | 2026-08-08T08:10:29Z |
| completed_at column | **null** |
| Status completed at | 2026-09-15T08:00:55Z (`order_status_poll`) |
| plan_duration_days | 30 |
| activation_result | `ACTIVATED` |
| started_at | 2026-09-15T08:00:55Z |
| expires_at after correction | 2026-09-06T21:00:00Z (= Aug 8 + 30d midnight EAT) |
| sub updated_at | 2026-09-15T08:27:58.905Z |
| active_now | false |

Chain: **EXPIRED → PAID → COMPLETED → ACTIVATED → CORRECTION OVERWRITE → NO LIVE ENTITLEMENT**

### Example 2 — Wiki 1 (8d)

| Field | Value |
|-------|--------|
| Device | `de0df903bbd0…` |
| Order | `osm_sp_1788689415742_fc8afeedc0` |
| created_at | 2026-09-06 |
| completed (updated_at) | 2026-09-14T18:01:18Z |
| completed_at | null |
| activation | ACTIVATED |
| expires_at | 2026-09-13T21:00:00Z (create+8d) |
| batch updated_at | 2026-09-15T08:27:58.905Z |

### Example 3 — Wiki 1 (7d), June order completed Sep 14

| Field | Value |
|-------|--------|
| Device | `aef4b17a3fea…` |
| Order | `osm_sp_1782212484601_376f6babdc` |
| created_at | 2026-06-23 |
| completed | 2026-09-14T17:28:47Z |
| activation | ACTIVATED |
| expires_at | 2026-06-29T21:00:00Z |
| batch updated_at | 2026-09-15T08:27:58.905Z |

### Examples 4–5

Same pattern: `493f76dc7378…` / `e6b7b0dbdb23…` — ACTIVATED at Sep 14 completion, expires rewritten to create+duration, identical correction `updated_at`.

### Secondary example — MOVED_TO_SIBLING

Paying device with `transaction_id LIKE 'moved:%'`:

- New completed payment on source device
- `activation_state: MOVED_TO_SIBLING_DEVICE`, `activated: false`
- Entitlement intentionally not granted on source (transfer guard)

This is a separate intentional skip, but presents the same customer symptom if they pay on the old device after transfer/expiry.

---

## AFFECTED CUSTOMERS IDENTIFIED

- **5** fully evidence-chained victims of correction overwrite  
- **≥14** in last-30-days completed-without-active sample with linked txn + past expiry  
- **78** additional live subscriptions currently classified as repair candidates that would shorten future→past under the same broken credit clock (audit only — not applied in this investigation)  
- Plus ongoing **MOVED_TO_SIBLING** completions on source devices (count varies; dominated recent audit samples)

PII minimized: full phones/device IDs retained only in secure ops artifacts, not required for root cause.

Payment history for affected orders: **preserved** as `completed`.

---

## CASE A vs CASE B

| | CASE A: active → pay again | CASE B: expired → pay again |
|--|----------------------------|-----------------------------|
| Checkout | Blocked by `ACTIVE_SUBSCRIPTION_EXISTS` while live | Allowed |
| Activation if somehow completed | May preserve expiry / txn ownership | Fresh midnight-EAT grant from now |
| Observed bug | Uncommon (gate) | Common when stale order + null `completed_at` + correction |

---

## HISTORICAL ENTITLEMENT REPAIR INTERACTION

**Proven: YES — the Sep 15 historical entitlement correction apply is the destructive step.**

It did not invent the missing `completed_at` (that was pre-existing), but it **exposed and weaponized** it by rewriting correctly activated renewals to past expiries.

Do **not** re-run correction until credit clock is fixed.

---

## RECOMMENDED MINIMAL FIX

**(Description only — DO NOT IMPLEMENT IN THIS TASK)**

1. **Set `transactions.completed_at = now()`** (once) in `applySonicpesaPaymentOutcome` when transitioning to `completed`.
2. **Backfill** `completed_at` for existing completed payment orders from trustworthy signals (`updated_at` when status completed, webhook/poll timestamps in `raw_payload`) — carefully, read-only verify first.
3. **Targeted restore** for victims: where `activation_result.activation_state = ACTIVATED`, `started_at` is after prior expiry, and `expires_at < started_at` (or `< completed`), recompute expiry as `midnight_EAT(started_at or completed_at) + plan_duration_days` and restore — using correction backups where present.
4. **Hardening:** refuse historical correction mutations that set `expires_at < started_at` or that use `created_at` when `status=completed` and `completed_at` is null without an explicit fallback policy.
5. Optionally surface clearer Admin UX for `MOVED_TO_SIBLING_DEVICE` so transfer-source payments are not mistaken for silent grant failures.

Do **not** rewrite the general payment provider integration beyond setting `completed_at`.

---

## FILES / FUNCTIONS INVOLVED

| Area | File / function |
|------|-----------------|
| Completion without `completed_at` | `server/src/lib/canonicalPaymentActivation.js` → `applySonicpesaPaymentOutcome` |
| Activation | `activateFromCompletedTxn`, `billingStore.upsertDeviceSubscriptionActive`, `computeDeviceSubscriptionExpiryAfterPurchase` |
| Credit clock | `server/src/lib/subscriptionExpiryAudit.js` → `loadCreditEventsForDevice(s)` (`COALESCE(completed_at, created_at)`) |
| Destructive overwrite | `server/src/lib/historicalEntitlementCorrection.js` → classify + apply mutations |
| Transfer skip | `transferRevocationGuard.isIntentionalMigrationRevokedDevice`, `MOVED_TO_SIBLING_DEVICE` branch in `activateFromCompletedTxn` |
| Active checkout gate | `server/src/lib/activeSubscriptionPaymentGate.js` |

---

## FORMAT BLOCK

```
VERDICT: ROOT CAUSE IDENTIFIED

BUG SCOPE: Expired (or lapsed) customer pays successfully; activation grants;
           historical correction rewrites expires_at using order created_at
           because completed_at is null → past expiry → no live entitlement

CONFIRMED EXAMPLES: 5 deep + 14 in 30d sample (+ 78 at-risk if correction re-run)

PAYMENT SUCCESS: YES
TRANSACTION COMPLETION: YES
ACTIVATION ATTEMPT: YES
ACTIVATION SUCCESS: YES (at grant time)
NEW ENTITLEMENT CREATED: YES then DESTROYED (expires_at overwritten to past)

FAILURE POINT: Post-activation historical entitlement correction
               (wrong credit timestamp due to null completed_at)

ROOT CAUSE: applySonicpesaPaymentOutcome never sets completed_at;
            correction/replay uses COALESCE(completed_at, created_at);
            late-completed renewals after expiry get past canonical expiry
            written over a correct future grant

EXPIRED-SUBSCRIPTION CONNECTION: Proven indirect — stale post-expiry
            completions maximize created_at vs pay-success gap

PAYMENT SYSTEM: Functioning (complete + activate succeed)

DATABASE: Entitlement row exists; expires_at incorrectly past; not a unique-constraint block

WEBHOOK: Often order_status_poll completion; activation ran; not the break point

ACTIVATION: Succeeds; not the break point for primary path

CACHE/API: Reflects DB truth (no live entitlement)

HISTORICAL EXAMPLES: See evidence chains above

AFFECTED CUSTOMERS IDENTIFIED: ≥5 proven overwrite victims; ≥14 sample matches;
                               plus MOVED_TO_SIBLING source-device pays

RECOMMENDED MINIMAL FIX: Persist completed_at; backfill; restore victims;
                         harden correction against created_at fallback /
                         expires_at < started_at — DO NOT IMPLEMENT YET

FILES/FUNCTIONS INVOLVED: canonicalPaymentActivation.applySonicpesaPaymentOutcome;
                          subscriptionExpiryAudit.loadCreditEvents*;
                          historicalEntitlementCorrection;
                          activateFromCompletedTxn / upsertDeviceSubscriptionActive

NO CHANGES MADE: CONFIRM
NO DEPLOYMENT: CONFIRM
```

---

## NO CHANGES MADE

**CONFIRM** — read-only investigation only (HTTP audits, device investigations, code review). No code edits, no DB mutations, no provider/webhook changes, no deploy, no service restarts for mutation purposes.
