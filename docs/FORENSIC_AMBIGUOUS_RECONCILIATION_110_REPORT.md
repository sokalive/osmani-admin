# Forensic Ambiguous Reconciliation Report — 110 NEEDS_MANUAL_REVIEW

**VERDICT: PASS**

**REFERENCE DATE:** 15 September 2026 EAT (`2026-09-14T21:00:00.000Z`)

---

## Summary

| Metric | Count |
|--------|------:|
| Investigated (original ambiguous set) | **110** |
| Resolved | **110** |
| PROVEN_EXPIRED | **110** |
| PROVEN_ACTIVE | 0 |
| OVER_CREDITED_BUT_STILL_ACTIVE | 0 |
| UNDER_CREDITED | 0 |
| REVOKED/TRANSFERRED (excluded from set) | — |
| REMAINING_MANUAL_REVIEW | **0** |
| Mutations applied | **7** |
| Resolved without mutation (already inactive) | **103** |

Also corrected **2** newly discovered evidence-backed over-credits outside the 110 (`77e4866b…`, `e789a856…`) via historical correction apply.

---

## Composition of the 110

| Pattern | Count | Finding |
|---------|------:|---------|
| `admin_manual:*` + `status=pending` | 98 | Placeholder rows created by admin block upsert — **never a paid package**. `expires_at` already past reference. Access already denied. |
| `manual_grant:N` + `status=active` | 10 | Soft-deleted/orphaned grants recovered by **exact grant id** (including deleted). All canonical expiries before 15 Sep. |
| `osm_sp_*` + `status=active` | 2 | Order lookup by exact order_id; already past expiry / inactive for access. |

**active_as_of_audit before repair:** 0 of 110  
(None granted access on 15 Sep 2026.)

---

## Evidence sources inspected

- Transactions by device / order_id  
- Manual grants by id (including `deleted_at IS NOT NULL`) and by device  
- Device transfers + sibling completed payments  
- Phone-linked completed payments (only unique, non-placeholder)  
- SonicPesa webhook inbox + reconciliation queue  

Historical durations recovered in this set: **2, 7, 30** days.

---

## Mutations (7)

All `PROVEN_EXPIRED` — align `expires_at` to midnight-EAT canonical from exact grant evidence:

| Device | Before | After (canonical) | Evidence |
|--------|--------|-------------------|----------|
| f5b3604f…502a | 2026-07-24T15:25:03Z | 2026-07-23T21:00:00Z | exact_grant_id |
| 9c8e864b…695e | 2026-07-13T16:52:52Z | 2026-07-12T21:00:00Z | exact_grant_id |
| 9e6d3346…b081 | 2026-07-12T16:46:54Z | 2026-07-11T21:00:00Z | exact_grant_id |
| 50178d2e…5a3a | 2026-07-11T21:16:50Z | 2026-07-11T21:00:00Z | exact_grant_id |
| aurax-live-probe-001 | 2026-07-07T15:57:08Z | 2026-07-06T21:00:00Z | exact_grant_id |
| b2e5531b…dd1e | 2026-07-01T15:21:23Z | 2026-06-30T21:00:00Z | exact_grant_id |
| bc687d7f…15f2 | 2026-06-26T13:58:32Z | 2026-06-25T21:00:00Z | exact_grant_id |

**Batch:** `a1924f7c-30f3-4fd9-86be-e5a9f357b46d`  
**Backup table:** `forensic_ambiguous_reconciliation_backups`

---

## Why 103 needed no mutation

They were already inactive for access:

- `expires_at <= 2026-09-14T21:00:00.000Z`
- mostly `status=pending` + `admin_manual:` placeholders with **zero** completed payments/grants

Classification: **PROVEN_EXPIRED** (no qualifying entitlement; customer must pay for new access).  
Accounts and payment history untouched.

---

## Extra historical repairs (outside the 110)

| Device | Before | After | Why |
|--------|--------|-------|-----|
| 77e4866b…7d1a | 2026-10-14 | 2026-07-12 | completed payment 30d from 2026-06-13 |
| e789a856…9f82 | 2026-10-14 | 2026-09-13 | completed payment 30d from 2026-08-15 |

---

## Post-validation

| Check | Result |
|-------|--------|
| Forensic mutations remaining | **0** |
| Historical repair candidates | **0** |
| Over-credited | **0** |
| Under-credited | **0** |
| Remaining NO_RELIABLE_EVIDENCE (in 110) | **0** |
| Backups | PASS |
| Cache invalidation | PASS (per changed device) |
| Idempotency | PASS |
| API health | PASS |
| Users/transactions deleted | **0** |

---

## GitHub / Deploy

| Item | Value |
|------|-------|
| Forensic tooling | `d90e24bb484e7d3a4b17a63cf4b938bdcabf64ae` |
| Filter scope fix | `a375e9c19a23…` |
| Deploy VPS | 144.91.117.90 (Contabo reload API) |
| Endpoints | `GET/POST /api/runtime/forensic-ambiguous-reconciliation-*` |

---

## Files

- `server/src/lib/forensicAmbiguousReconciliation.js`
- `server/src/routes/runtimePublic.js`
- `server/src/lib/historicalEntitlementCorrection.js` (placeholder → EXPIRED)
- `server/scripts/test-forensic-ambiguous-reconciliation.mjs`
