# OSMANI FINAL MIGRATION READINESS AUDIT

**Date:** 2026-09-12 (America/Los_Angeles calendar context; Contabo host local time CEST)  
**Scope:** Read-only inventory + migration readiness analysis only.  
**Status:** AUDIT COMPLETE — **no migration executed**, no production mutations.

**Safety statement:** No DNS, Nginx, PM2, env, PostgreSQL config, payment/webhook, Contabo, or Vultr changes were made during this audit. No dumps were created. No rows were inserted/updated/deleted.

**Evidence sources:**
- SSH read-only probes on Contabo `144.91.117.90` (Osmani paths only)
- Read-only PostgreSQL queries via app `DATABASE_URL` with `default_transaction_read_only = on`
- Authenticated Vultr CDP session (backup/snapshot UI visibility check)
- Application source (`billingStore.js`, payment routes, Nginx configs)
- Prior inventory: `docs/OSMANI_PRODUCTION_INFRASTRUCTURE_INVENTORY.md`

**Secrets policy:** No passwords, API keys, JWT secrets, PINs, tokens, cookies, or credentialed connection strings. Names only + `[CONFIGURED]` / `[SECRET PRESENT]` / `[REDACTED]`.

---

## 1. Executive Summary

Osmani production is a **split architecture**:

| Layer | Location |
|-------|----------|
| Apps, Nginx, TLS, uploads | Contabo VPS `144.91.117.90` |
| PostgreSQL system of record | Vultr `osmani-tv` `155.138.223.205:5432` / DB `osmani_db` / PG **18.4** |

**Entitlement truth** is device-centric in `device_subscriptions` (`status='active'` AND `expires_at > now()` AND `admin_revoked_at IS NULL`, minus block flags). Packages are **preservable** if the entire `osmani_db` is dumped/restored with sequences, plus Contabo uploads and secrets.

### FINAL GO / NO-GO

# **NOT READY — BLOCKERS FOUND**

Primary blockers (process / proof gaps, not “data is unmigratable”):

1. **No verified automated PostgreSQL backup** on Contabo (no root crontab `pg_dump`; no dump artifacts found as scheduled jobs).
2. **Vultr instance backup/snapshot schedule not confirmed** in the authenticated UI pass (`backup_text_absent`, `snapshot_text_absent`).
3. Migration must not proceed until a **tested dump → restore → entitlement parity** path exists on a non-production target.
4. **ZenoPay webhook URL still points at an external Supabase function**, not only `api.osmanitv.com` — hidden payment continuity dependency.
5. **Operational size risk:** DB ~**2576 MB** with `client_api_telemetry` ~**1857 MB** / ~8.06M rows — dump/restore window and disk planning required.

Data itself is structured such that **zero-loss is achievable** after those blockers are closed. This audit does **not** authorize cutover.

---

## 2. Current Architecture

```
Clients / Admin operators / Payment providers
                │
                ▼
 DNS: osmanitv.com | admin.osmanitv.com | api.osmanitv.com
                │
                ▼
     Contabo 144.91.117.90
     Nginx TLS (Let's Encrypt osmanitv.com)
        ├─ Admin SPA (dist/)
        ├─ Public SPA (/var/www/osmanitv.com)
        ├─ osmani-admin-api :10001  (PM2)
        └─ osmani-tv-backend :10000 (PM2; path /var/www/osmani-tv/backend)
                │
                │  DATABASE_URL (SSL on)
                ▼
     Vultr osmani-tv 155.138.223.205:5432
     PostgreSQL 18.4 / osmani_db / osmani_db_user

External SaaS (must remain): Bunny CDN, Resend, OneSignal, Beem,
SonicPesa / AuraxPay / ZenoPay (+ ZenoPay Supabase webhook endpoint)
```

---

## 3. Current VPS

| Item | Evidence |
|------|----------|
| IP | `144.91.117.90` |
| Hostname | `vmi3380657` |
| OS | Ubuntu 24.04.4 LTS, kernel `6.8.0-139-generic` |
| CPU | 4 vCPU |
| RAM | 7.8 GiB (~681 MiB used at audit) |
| Disk | 145G, ~18G used (13%) |
| Node | `v22.22.3` |
| PM2 | `osmani-admin-api` online (fork, `:10001`); `osmani-tv-backend` online (fork, `:10000`) |
| Paths | `/var/www/osmani-admin-api`, `/var/www/osmani-tv/backend`, `/var/www/osmanitv.com` |
| UFW | historically 22/80/443 (from prior inventory) |
| Docker | not used for Osmani stack |

### Env variable **names** present (values not printed)

**Admin API `.env`:**  
`DATABASE_URL`, `BASE_URL`, `STREAM_API_BASE_URL`, `ADMIN_PUBLIC_URL`, `UPLOAD_DIR`, `BUNNY_CDN_BASE_URL`, `NOTIFICATION_IMAGE_PUBLIC_ORIGIN`, `INSTRUCTION_VIDEO_PUBLIC_ORIGIN`, `ADMIN_*` (JWT/PIN/OTP/session/trust), `RESEND_*`, `ONESIGNAL_*`, `BEEM_*`, `ADMIN_API_TOKEN`, `APP_UPDATE_ADMIN_TOKEN`, `MANUAL_SUBSCRIPTION_ADMIN_PIN`, `ANALYTICS_RESET_*`, `TRANSFER_DEBUG_TOKEN`, `OSMANI_LOAD_CUTOVER_ENV`, …

**TV backend `.env`:** `DATABASE_URL` only (key confirmed).

---

## 4. Current PostgreSQL / Vultr

| Field | Value |
|-------|-------|
| Instance label | `osmani-tv` (Atlanta, Running) |
| Host | `155.138.223.205` |
| Port | `5432` |
| Database | `osmani_db` |
| App role | `osmani_db_user` (non-superuser, login) |
| Superuser | `postgres` (exists; not used by apps in normal path) |
| Version | **18.4** (`Ubuntu 18.4-1.pgdg24.04+1`) |
| Size | **2576 MB** |
| SSL | `on` (app uses TLS with `rejectUnauthorized: false` for remote) |
| Ownership | Public tables owned by `osmani_db_user` |
| Extensions | `plpgsql` 1.0, `pgcrypto` 1.4 |
| Schemas | `public` (+ catalog schemas) |
| Base tables | **58** |
| Indexes | **164** (public) |
| Views | **none** in `public` |
| Triggers | **none** in `public` |
| Custom functions | none beyond `pgcrypto`/`pgcrypto`-related |
| Sequences | 20+ including `transactions_id_seq` last≈3213, `plans_id_seq` last=13, telemetry id≈8.06M |

**Vultr backup UI:** CDP pass did **not** surface backup/snapshot schedule text. Treat as **unconfirmed**.

---

## 5. Complete Database Dependency Map

### Critical commerce / entitlement graph

```
plans (id SERIAL)
  ↑ plan_id FK
transactions (id SERIAL, order_id UNIQUE, device_id, phone, status, plan_duration_days, raw_payload, …)
  ↑ logical link via device_subscriptions.transaction_id ≈ transactions.order_id
device_subscriptions (PK device_id, UNIQUE transaction_id, status, expires_at, revoke/block flags)

manual_subscription_grants → plans
subscriptions (legacy phone PK) → plans
subscription_requests → plans
admin_payment_recovery_actions → plans

sonicpesa_settings / zenopay_settings / auraxpay_settings / checkout_payment_settings / payment_providers
sonicpesa_webhook_inbox + sonicpesa_payment_reconciliation_queue
```

### Device / support graph

```
device_phone_registry (PK device_id + install_instance_id)
device_intelligence_registry ← login_log / device_history / admin_actions
device_security_profiles, security_*, admin_devices
app_installs, client_api_telemetry (largest store)
```

### Admin security graph (FK-enforced)

```
admin_panel_users
  ← admin_panel_trusted_devices (trusted_expires_at, credential hash, blocked/revoked)
  ← admin_panel_sessions
  ← admin_panel_login_otps
  ← admin_panel_security_events
```

### Content / ops

`channels`, `banners`, `app_settings`, `notifications`, SMS/Beem tables, offer/transfer tables, integrity audit tables.

**Important:** `device_subscriptions.transaction_id` is **NOT** a formal FK to `transactions`. Access checks do **not** join payments. Preserve both tables fully anyway for history/recovery.

---

## 6. User / Subscription / Package Architecture

There is **no classic end-user `users` table**. Identity is:

1. `device_id` (and fingerprint hash)
2. Optional phone via `device_phone_registry` / `transactions.phone`
3. Entitlement row in `device_subscriptions`

### `device_subscriptions` (authoritative package state)

| Metric | Count |
|--------|------:|
| Total rows | **1429** |
| Active valid (`status='active'` AND `expires_at > now()`) | **135** |
| Expired / past `expires_at` | **1213** |
| `admin_revoked_at` set | **148** |
| `manual_admin_blocked` | **1** |
| Status mix | active 737 / pending 545 / revoked 147 |

**Columns (production):**  
`device_id` (PK text), `status`, `expires_at` (timestamptz), `started_at`, `transaction_id` (UNIQUE text), `updated_at`, `fingerprint_hash`, `manual_admin_blocked`, `admin_revoked_at/by/reason`, `admin_revoked_transaction_id`, schema/engine migration stamps.

**Indexes:** PK on `device_id`; UNIQUE on `transaction_id`; `(status, expires_at)`; partial active `expires_at`; fingerprint partial.

### Related counts

| Table | Rows |
|-------|-----:|
| `transactions` | 2728 (pending 1343 / completed 971 / failed 414) |
| `plans` | 13 (4 active soft-live: ids 10–13) |
| `device_phone_registry` | 821 |
| `device_intelligence_registry` | 5890 |
| `manual_subscription_grants` | 138 |
| `sonicpesa_webhook_inbox` | 5248 |
| `sonicpesa_payment_reconciliation_queue` | 1011 |
| `payment_transactions` | 0 (empty legacy) |
| `subscriptions` (legacy) | 1 |

`transaction_id` match modes: **773** match `transactions.order_id`; **0** match numeric `id`; **656** match neither — overwhelmingly synthetic `admin_manual:*` / manual patterns. **Only 3** active-valid rows unmatched to `transactions` (expected for some manual grants).

---

## 7. Entitlement Logic

Canonical API evaluation (`getDeviceSubscriptionAccessState` / `Fast` in `server/src/billingStore.js`):

**Valid package IF:**

```text
device_subscriptions.status = 'active'
AND expires_at > now()
AND admin_revoked_at IS NULL
AND blocked_now = false
```

Where `blocked_now` (full path) is OR of:
- `device_subscriptions.manual_admin_blocked`
- `admin_devices.is_blocked`
- `device_intelligence_registry.status = 'blocked'`

Remaining days use timezone **`Africa/Dar_es_Salaam`**.

### End-to-end path

```
Device / phone registry
  → Payment webhook / poll / manual grant
  → transactions (+ provider inbox)
  → activate/upsert device_subscriptions (expires_at + status + transaction_id)
  → API verify / playback gate reads device_subscriptions (+ block registries)
  → App access
```

**Hidden migration risks for packages:**
- Truncated/partial restore omitting `device_subscriptions` or wrong sequences
- Clock/timezone skew on new host (use timestamptz; keep TZ consistent)
- Changing `device_id` format or wiping registries used for blocks
- Restoring apps against empty/new DB
- Cache is not SoT (in-process only) — DB must be correct

**Packages do NOT depend on:** Bunny, Resend, Contabo IP itself — they depend on **DB rows + API serving those rows**.

---

## 8. Payment Architecture

| Provider | Webhook URL (DB) | Notes |
|----------|------------------|-------|
| **SonicPesa** (current checkout) | `https://api.osmanitv.com/api/payments/sonicpesa/webhook` | Inbox + reconcile workers in Admin API |
| **AuraxPay** | `https://api.osmanitv.com/api/payments/auraxpay/webhook` | Domain-stable preferred |
| **ZenoPay** | `https://ggzxsblrimmpgmtvwlhs.supabase.co/functions/v1/zenopay-webhook` | **External Supabase** — not Contabo |

Checkout provider setting: **`sonicpesa`**.

Must preserve unchanged for continuity:
- Full `transactions` + SonicPesa inbox/queue
- Provider settings rows (api_key/secret/webhook columns — `[SECRET PRESENT]` in DB)
- Env integrations where used (`BEEM_*`, etc.)
- Public DNS for `api.osmanitv.com` after cutover
- Understanding of ZenoPay’s Supabase callback path if Zeno remains enabled

Do **not** rotate provider webhook secrets mid-cutover without a dual-accept window.

---

## 9. Backup / Restore Readiness

| Check | Result |
|-------|--------|
| Contabo root crontab DB dumps | **NONE** (`NO_ROOT_CRONTAB`) |
| Scheduled systemd PG dump timers | **Not found** (only certbot/sysstat/etc.) |
| Dump files under `/var/backups` / `/root` / `/var/www` | No live `pg_dump` artifacts as scheduled backups |
| Historical file tree | `/var/www/osmani-tv-backup-before-contabo-cutover` (app tree, not DB SoT) |
| Vultr automated backups/snapshots | **Not confirmed** in UI pass |
| This audit created a dump? | **No** (forbidden) |

### Recommended future backup strategy (design only)

1. On Vultr DB host (or via Contabo with read-only role):  
   `pg_dump -Fc -d osmani_db` (custom format) **and** optional schema-only SQL.
2. Verify dump with `pg_restore --list` + restore onto **staging** PG **≥ 18**.
3. Compare critical counts (section 17) + sample entitlement probes.
4. Enable Vultr instance backups **or** nightly off-box dump to object storage **before** cutover authorization.
5. Size planning: full DB ~2.6 GB on disk; dump compressed likely much smaller but telemetry dominates — decide whether cutover restore includes full telemetry or archives it separately (**entitlement tables are in the ~719 MB non-telemetry portion**, but safest cutover restores **entire** DB unless explicitly approved otherwise).

---

## 10. Data Integrity Findings

| Check | Result | Migration impact |
|-------|--------|------------------|
| Orphan `transactions.plan_id` | **0** | OK |
| Orphan `subscriptions.plan_id` | **0** | OK |
| Orphan `manual_subscription_grants.plan_id` | **0** | OK |
| Duplicate active devices | **0** | OK |
| `status=active` but `expires_at <= now()` | **602** | Known stale status; runtime denies via `expires_at` |
| Future expiry but non-active | **81** (5 revoked, 1 blocked) | Expected for revoked/pending |
| `transaction_id` not in `transactions` | **656** (mostly `admin_manual:*`) | Expected; not FK |
| Active-valid unmatched txn | **3** | Low; likely manual_grant style |

**No repairs performed.** Stale `active`+expired rows are **not** a migration blocker; they are an existing hygiene issue already handled by runtime.

---

## 11. Upload/File Storage

| Item | Value |
|------|-------|
| Path | `/var/www/osmani-admin-api/server/uploads` |
| Size | **~211 MB** |
| File count | **827** |
| Large dirs | `videos/` ~87M, `apks/` ~87M |
| Storage type | **Local disk** on Contabo |
| CDN | Bunny `https://osmanitv.b-cdn.net` (`BUNNY_CDN_BASE_URL`) — external |
| DB references | Channel/banner/notification paths often relative/public URLs via `api.osmanitv.com` / CDN |

**Must copy** entire uploads tree; prefer **unchanged URL paths** (`/uploads/...` on `api.osmanitv.com`).

---

## 12. DNS/Nginx/TLS

| Domain | A record | Role |
|--------|----------|------|
| `osmanitv.com` | `144.91.117.90` | Public SPA root `/var/www/osmanitv.com` |
| `www.osmanitv.com` | (vhost present; A may be empty/alias) | Same site |
| `admin.osmanitv.com` | `144.91.117.90` | Admin SPA + `/api` → `:10001` |
| `api.osmanitv.com` | `144.91.117.90` | API + webhooks + uploads |
| `admin.osmani.tv` / bare IP | default `:80` server | Legacy/fallback |

**TLS:** `/etc/letsencrypt/live/osmanitv.com/` (SAN covers branded hosts).  
**Nginx enabled:** `osmani-admin`, `osmanitv-domains` + snippet `osmani-node-api.conf`.

### Future DNS change (not executed)

After new VPS is verified: point **same names** to **new VPS IP**. Domains should **not** change. Lower TTL ahead of cutover. Payment providers keep calling `api.osmanitv.com` (except ZenoPay → Supabase).

---

## 13. External Services

| Service | Purpose | Config location | Secret names | Domain dependency | Migration impact |
|---------|---------|-----------------|--------------|-------------------|------------------|
| Bunny CDN | Media delivery | Env `BUNNY_CDN_BASE_URL` (+ optional API purge keys) | `BUNNY_*` if used | `osmanitv.b-cdn.net` | Keep; update origin if needed |
| Resend | Admin OTP email | Env | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | `api.resend.com` | Copy secrets |
| OneSignal | Push | Env | `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` | `api.onesignal.com` | Copy secrets |
| Beem | SMS | Env (+ `beem_settings`) | `BEEM_API_KEY`, `BEEM_SECRET_KEY`, `BEEM_SENDER_NAME` | Beem API | Copy secrets |
| SonicPesa | Checkout + webhooks | DB settings + env overrides | DB `api_key` / webhook secret fields | `api.osmanitv.com` webhook | Keep domain; copy DB row |
| AuraxPay | Payments | DB | webhook_secret/api_key | `api.osmanitv.com` | Same |
| ZenoPay | Payments | DB | api_key + **Supabase webhook URL** | Supabase function URL | Preserve URL or reconfigure provider |
| Let's Encrypt | TLS | `/etc/letsencrypt` | private keys on disk | ACME HTTP-01 | Re-issue on new VPS |
| GitHub | Code | remotes | deploy tokens if any | github.com | Redeploy from git |

---

## 14. Admin Security Data

Stored in PostgreSQL (must preserve):

| Table | Approx rows | Notes |
|-------|------------:|-------|
| `admin_panel_users` | 1 | Admin identity |
| `admin_panel_trusted_devices` | 1 | Includes `trusted_expires_at`, credential hash, blocked/revoked |
| `admin_panel_sessions` | 1 | Session/JTI state |
| `admin_panel_login_otps` | 48 | OTP challenges |
| `admin_panel_security_events` | 6 | Audit |

Also preserve env: `ADMIN_JWT_SECRET`, PINs, bootstrap credentials, cookie/TTL settings (`ADMIN_TRUSTED_DEVICE_DAYS=14`, session TTL).

If JWT secret changes unexpectedly, sessions break (trusted device may still allow restore via `/session` while trust valid). If trusted device rows lost, operators re-OTP.

---

## 15. Migration Dependencies

### MUST copy
- Entire `osmani_db` (all 58 tables + sequences + extensions + ownership)
- Contabo `server/uploads`
- Admin `.env` secrets (recreate securely; never commit)
- TV backend `DATABASE_URL`
- Nginx vhost logic (recreate) + certbot
- PM2 process definitions for both apps
- Public SPA files `/var/www/osmanitv.com`

### MUST remain / stay consistent
- Domains `api` / `admin` / `osmanitv.com`
- Payment provider accounts + SonicPesa/Aurax webhook paths on `api.osmanitv.com`
- ZenoPay Supabase webhook (or intentional redesign)
- Bunny / Resend / OneSignal / Beem accounts

### Hard-coded / path risks
- Nginx `server_name` includes `144.91.117.90`
- Code references Contabo IP in helpers (`isVpsProduction`, OneSignal env detection, docs/scripts)
- Default webhook URLs in DDL seed to `api.osmanitv.com`
- Absolute paths `/var/www/osmani-admin-api/...`
- Pool defaults assume VPS production when `BASE_URL` matches api domain or Contabo IP

### Target PG
Restore onto **PostgreSQL ≥ 18** (source is 18.4). Require `pgcrypto`.

---

## 16. Zero-Data-Loss Migration Plan

**Design only — not executed.**

1. **Build new VPS** (Ubuntu 24.04 LTS recommended) — no DNS yet.  
2. Install OS packages, Node 22, Nginx, PM2, UFW 22/80/443, certbot.  
3. Install PostgreSQL **18.x** (or managed PG 18+ in same region).  
4. **Establish verified backup first** (close blockers): take `pg_dump -Fc`, restore to staging, verify counts.  
5. Restore production dump to new PG; preserve roles/`osmani_db_user` ownership or remap carefully.  
6. Verify DB integrity (section 17).  
7. Deploy app code from GitHub; copy uploads; recreate `.env` with `DATABASE_URL` → **new** PG host.  
8. Configure PM2 both processes; do **not** point public DNS yet.  
9. Configure Nginx + issue TLS for same domains (hosts file / staging hostname for tests).  
10. Wire external integrations (same secrets).  
11. Start apps on private/test hostname.  
12. Health checks, entitlement sample checks, payment webhook dry-run (provider sandbox if available), Admin auth OTP.  
13. Compare old vs new DB metrics.  
14. **Maintenance window:** freeze writes (stop Contabo app writers **or** brief dual-read with write freeze), final incremental dump/restore or failover.  
15. DNS cutover: `api`/`admin`/`osmanitv.com` → new IP.  
16. Monitor webhooks + active subscription API.  
17. Keep Contabo + Vultr warm for rollback until soak period ends.  
18. Only then decommission old edge/DB.

### Downtime
- **DNS cutover:** brief webhook/API blip proportional to TTL + app start (minimize with low TTL + pre-warmed new stack).  
- **Final DB cut:** write freeze required to avoid split-brain (minutes depending on dump strategy).  
- Prefer: new stack fully hot → freeze Contabo writers → final sync → DNS flip.

---

## 17. Verification Plan

Compare **CURRENT Vultr `osmani_db`** vs **NEW VPS DB**:

| Check | Pass criteria |
|-------|---------------|
| DB size (order of magnitude) | Match within expected vacuum/toast variance |
| Table list | Identical 58 public tables |
| Row counts | Exact match for critical tables at freeze instant |
| `device_subscriptions` total / active_valid | Exact |
| `transactions` total + status breakdown | Exact |
| `plans` count + active ids | Exact |
| Device registries | Exact |
| Admin security tables | Exact |
| Sequences (`transactions_id_seq`, etc.) | `last_value` ≥ source; no ID collision risk |
| Extensions | `pgcrypto`, `plpgsql` |
| Indexes/constraints | Present (count ≈164) |
| Sample devices | Same `active_now` / `expires_at` via API |
| Webhook inbox depth | Match or explain delta during freeze |
| Uploads file count/size | Match Contabo source |
| Admin login | Trusted device restore or OTP enrollment works |

**Success ≠ Postgres starts.** Success = identical entitlement responses for sample active devices + completed payments still linked + Admin auth operable.

---

## 18. Rollback Plan

**Design only.**

1. **Pre-cutover:** keep Contabo apps + Vultr DB intact until soak complete.  
2. If new VPS fails **before** DNS: leave DNS on Contabo; no user impact.  
3. If fails **after** DNS:  
   - Repoint DNS A records for `api`/`admin`/`osmanitv.com` back to `144.91.117.90`.  
   - Ensure Contabo `.env` still points at **authoritative** DB.  
4. **Avoid divergent DBs:** during cutover, only **one** writer primary. If new PG received writes after flip, either:  
   - fail forward after repair, or  
   - dump new writes and merge carefully (payment double-apply risk). Prefer short freeze + single primary.  
5. **Payments:** providers call domains/URLs — DNS rollback restores SonicPesa/Aurax to Contabo. ZenoPay Supabase path unchanged.  
6. **Idempotency:** SonicPesa inbox unique payload hashes reduce double activation; still freeze dual-writers.  
7. Do not delete old Contabo/Vultr until rollback window expires.

---

## 19. Risks / Blockers

### BLOCKERS (must close before GO)

1. No proven automated / verified PostgreSQL backup pipeline.  
2. Vultr backup/snapshot schedule unconfirmed.  
3. No completed staging restore + entitlement parity rehearsal.  
4. ZenoPay webhook dependency on Supabase must be inventoried with owner sign-off.  
5. Dump/restore capacity plan for ~2.6 GB DB (telemetry-heavy) not yet rehearsed.

### Additional risks (non-blocking but must plan)

- Cross-provider latency Contabo↔Vultr until consolidation.  
- 602 stale `active`+expired rows (runtime-safe).  
- Hard-coded Contabo IP in Nginx default server_name and some code paths.  
- Dual PM2 apps / dual git repos.  
- Payment secrets live in DB settings tables — must restore intact.  
- Admin trusted-device counts currently low (1) — still must preserve.

---

## 20. FINAL GO / NO-GO DECISION

# **NOT READY — BLOCKERS FOUND**

**Rationale:** Subscription/package data **can** be preserved with a full logical dump/restore of `osmani_db` plus uploads/config, and entitlement logic is well understood. However, migration must not be authorized while **backup verification and restore rehearsal are missing**, and while **Vultr backup posture + ZenoPay Supabase webhook** remain incompletely proven for cutover.

After blockers are closed and a staging restore proves count + entitlement parity, re-run this decision checklist for a possible **MIGRATION READY**.

---

## Critical Final Questions

1. **Can PostgreSQL currently be safely migrated to a new VPS?**  
   **Conditionally yes, after** verified dump/restore rehearsal on PG ≥ 18. **Not today** — backup readiness incomplete.

2. **Can all user subscriptions/packages be preserved?**  
   **Yes**, if entire `device_subscriptions` (and related block registries) restore bit-identically.

3. **Can transaction/payment history be preserved?**  
   **Yes**, via full `transactions` + provider inbox/queue + settings tables.

4. **Can device/subscription relationships be preserved?**  
   **Yes** — PK is `device_id`; phone registry composite PK must be included.

5. **Can Admin security data be preserved?**  
   **Yes** — restore `admin_panel_*` + keep `ADMIN_JWT_SECRET` / PIN env vars.

6. **Can uploads be preserved?**  
   **Yes** — copy `/var/www/osmani-admin-api/server/uploads` (~211 MB / 827 files).

7. **Can payment webhooks continue after migration?**  
   **Yes for SonicPesa/Aurax** if `api.osmanitv.com` DNS moves with the API and secrets preserved. **ZenoPay** continues via **Supabase URL** unless redesigned.

8. **Can the same production domains remain unchanged?**  
   **Yes** — recommended. Only A records change to new IP.

9. **What exact data MUST be copied?**  
   Full `osmani_db`; uploads tree; Admin security + commerce tables especially `device_subscriptions`, `transactions`, `plans`, registries, provider settings, webhook inbox/queue, `app_settings`, channels/banners.

10. **What exact configuration MUST be copied?**  
    Env names listed in §3 (values securely transferred); Nginx routing model; PM2 apps; TLS issuance for same domains; `DATABASE_URL` host/port/db/user; pool-related optional envs.

11. **What exact external services must remain unchanged?**  
    Bunny, Resend, OneSignal, Beem, SonicPesa, AuraxPay, ZenoPay(+Supabase webhook), DNS domain names, payment merchant accounts.

12. **What could cause user packages to disappear after migration?**  
    Incomplete DB restore; pointing apps at empty DB; wiped `device_subscriptions`; clock skew mis-handling; accidental status mass-update (forbidden); restoring without sequences then colliding on new writes.

13. **What could cause payments to stop working?**  
    DNS not updated; wrong webhook secrets; lost provider settings rows; workers not running; ZenoPay Supabase path broken; dual-writer split-brain.

14. **What could cause the Admin to stop working?**  
    Lost `ADMIN_JWT_SECRET` / PINs; lost `admin_panel_*` rows; Resend misconfig; TLS/cookie domain mismatch; Nginx not proxying `/api`.

15. **What could cause the TV app to stop working?**  
    `api.osmanitv.com` down; wrong entitlement DB; uploads/CDN origin broken; `osmani-tv-backend` not running if still required; stream base URL mis-set.

16. **What is the safest migration sequence?**  
    Verified backup → staging restore/parity → build new VPS → restore DB+uploads+env → private verify → write freeze → final sync → DNS cutover → soak → decommission.

17. **What is the safest rollback sequence?**  
    DNS back to Contabo; single writer on Vultr DB; do not destroy old hosts; reconcile any post-cutover writes carefully.

18. **Is there currently any missing backup or dependency that blocks migration?**  
    **Yes** — missing verified PG backup/restore rehearsal; Vultr backup unconfirmed; ZenoPay Supabase webhook dependency requires explicit ownership.

---

## Appendix A — Exact counts snapshot (audit time)

| Object | Value |
|--------|-------|
| DB size | 2576 MB |
| Tables | 58 |
| Indexes | 164 |
| `device_subscriptions` | 1429 (135 active valid) |
| `transactions` | 2728 |
| `plans` | 13 |
| `client_api_telemetry` | 8,059,121 |
| Admin trusted devices | 1 |
| Uploads | 211 MB / 827 files |

## Appendix B — Production changes during this audit

| Action | Result |
|--------|--------|
| Migration performed | **NO** |
| Database modified | **NO** |
| DNS modified | **NO** |
| Nginx / PM2 / env changed | **NO** |
| Services restarted | **NO** |
| Backups created | **NO** |

---

**End of final migration readiness audit.**
