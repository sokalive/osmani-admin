# Historical Entitlement Correction Report — 15 September 2026 (EAT)

## VERDICT: **PASS WITH LIMITATIONS**

Automatically repairable anomalies corrected. 110 subscriptions remain **NEEDS_MANUAL_REVIEW** (no credit-event evidence). No legitimate paid time was removed from still-active canonical entitlements.

---

## REFERENCE DATE

- **Business date:** 2026-09-15 Africa/Dar_es_Salaam  
- **Reference instant:** `2026-09-14T21:00:00.000Z` (2026-09-15 00:00 EAT)  
- **Policy:** no-stack midnight-EAT replay using `transactions.plan_duration_days` snapshot  

---

## SUMMARY

| Metric | Before repair | After repair |
|--------|---------------|--------------|
| Subscriptions audited | 1435 | 1435 |
| Transactions examined | 976 | 976 |
| Repair candidates | 501 | **0** |
| Over-credited (observational audit) | 7 | **0** |
| Under-credited | 1 | **0** |
| Ambiguous / manual review | 110 | 110 |
| Revoked (unchanged) | 149 | 149 |
| Transferred/moved (unchanged) | 472 | 472 |

**Rows corrected:** ~501 `device_subscriptions.expires_at` updates (batch `d7c67499-…` + primary apply batch)  
**Backup table:** `historical_entitlement_correction_backups`  
**Accounts/transactions deleted:** 0  

---

## KNOWN 7 + 1 (before → after)

| Device (masked) | Package evidence | Old expires_at | Canonical | As of 15 Sep 2026 | Action |
|-----------------|------------------|----------------|-----------|-------------------|--------|
| dcf943ed…135d | payments + grants | 2027-10-06 | 2026-09-07 EAT | EXPIRED | Corrected down; access removed |
| 673c64f5…8a55 | 3×30d payments | 2026-11-19 | 2026-09-22 EAT | **ACTIVE** | Corrected down; legitimate time kept |
| 59114171…550 | payments + grants | 2026-11-10 | 2026-09-07 EAT | EXPIRED | Corrected down |
| 468ab0d3…0ade | payments + grant | 2026-10-07 | 2026-10-07 EAT | **ACTIVE** | **CORRECT** — no mutation after completed_at fix |
| d647ed57…c95b | 7 events | 2026-10-01 | 2026-08-14 EAT | EXPIRED | Corrected down |
| 0658913c…15c2 | custom + grants | 2026-09-28 | 2026-07-30 EAT | EXPIRED | Corrected down |
| 3c78b974…477d | grants + payments | 2026-09-24 | 2026-07-26 EAT | EXPIRED | Corrected down |
| b9395cd2…3497 | 1×365d snapshotted txn | 2027-06-10 | 2027-06-10 EAT | **ACTIVE** | **CORRECT** — legitimate 365d snapshot matches DB |

---

## ROOT CAUSES ADDRESSED

1. Legacy stacking / manual-grant over-credit before no-stack hardening  
2. `updated_at` backfill batch (`2026-07-26T19:53:34.846Z`) polluting activation replay — fixed to `COALESCE(completed_at, created_at)`  
3. Upward repairs blocked when activation timestamp equals bulk backfill (200 false under-credits avoided)  

---

## VALIDATION (post-repair)

- Re-run historical audit: **0 repair candidates**  
- Subscription expiry audit: **over_credited=0, under_credited=0**  
- Idempotent re-apply: no further changes  
- PM2/API health: ok, commit `ec60bf559eda`  
- Pool: not saturated post-repair  

---

## UNRESOLVED / MANUAL REVIEW

110 subscriptions lack completed payment/grant credit events on the owning device (unsupported entitlements, legacy imports, or missing snapshots). **Not auto-mutated.**

---

## GITHUB COMMITS

- `3186e96` — historical entitlement correction tooling + API endpoints  
- `ec60bf559eda49b9b20942147ac8c001884a8f22` — completed_at replay + bulk-timestamp upward-repair guard  

---

## FILES

- `server/src/lib/historicalEntitlementCorrection.js`  
- `server/scripts/run-historical-entitlement-correction.mjs`  
- `server/src/lib/subscriptionExpiryAudit.js` (export bulk loader, completed_at)  
- `server/src/routes/runtimePublic.js` (audit/apply endpoints)  
