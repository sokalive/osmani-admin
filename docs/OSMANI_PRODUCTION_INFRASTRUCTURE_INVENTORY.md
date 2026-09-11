# OSMANI PRODUCTION INFRASTRUCTURE INVENTORY

**Date:** 2026-09-11  
**Scope:** Read-only discovery of current Osmani production (Contabo VPS + Vultr + PostgreSQL + domains).  
**Status:** INVENTORY ONLY — **no migration executed**, no production mutations, no DNS/firewall/DB changes.

**Evidence sources:**
- SSH to Contabo `144.91.117.90` (password auth; Nassani keys not used)
- Authenticated Vultr CDP browser session (port `9223`)
- Read-only PostgreSQL metadata queries (`default_transaction_read_only = on`)
- Nginx configs, PM2 process metadata (paths/ports only in this report), public health probes

**Secrets policy:** No passwords, API keys, JWT secrets, PINs, tokens, or connection strings with credentials are included. Use `[CONFIGURED]` / `[REDACTED]` / `[SECRET PRESENT]`.

---

## 1. Executive Summary

Osmani production is **split across two hosts**:

| Layer | Host | Role |
|-------|------|------|
| **Application / edge** | Contabo VPS `144.91.117.90` (`vmi3380657`) | Nginx TLS termination, Admin SPA, Admin API (`:10001`), TV Node backend (`:10000`), local uploads disk |
| **PostgreSQL** | Vultr Cloud Compute `osmani-tv` `155.138.223.205` (Atlanta) | Production DB `osmani_db` on PostgreSQL **18.4** |

Both Contabo app processes connect to the **same remote database**:

- Host: `155.138.223.205`
- Port: `5432`
- Database: `osmani_db`
- User: `osmani_db_user` (password `[REDACTED]`)

Production domains `admin.osmanitv.com`, `api.osmanitv.com`, `osmanitv.com` resolve to **Contabo** `144.91.117.90`.

**Critical migration implication:** Moving only Contabo without migrating/repointing PostgreSQL on Vultr (or vice versa) will break subscriptions, payments, and Admin auth. Zero-data-loss migration must treat **`osmani_db` on `155.138.223.205` as the system of record**.

---

## 2. Current Architecture Diagram

```
Mobile App / Browser / Admin Operator
                │
                ▼
   DNS: admin|api|osmanitv.com  →  144.91.117.90 (Contabo)
                │
                ▼
         Nginx (80/443 TLS)
          Let's Encrypt: osmanitv.com SAN
                │
    ┌───────────┼──────────────────────────────┐
    ▼           ▼                              ▼
 Admin SPA   Admin API :10001            Public SPA
 (dist/)     (osmani-admin-api)          (osmanitv.com/)
                │
                │  also: osmani-tv-backend :10000
                │  (PM2 name; path /var/www/osmani-tv/backend)
                ▼
     PostgreSQL 18.4 @ 155.138.223.205:5432 / osmani_db
                │
                ▼
         Vultr instance: osmani-tv (Atlanta, Running)

External (remain outside VPS unless redesigned):
  - Bunny CDN (osmanitv.b-cdn.net)
  - Resend (Admin OTP email)
  - OneSignal (push)
  - Beem (SMS)
  - SonicPesa / ZenoPay / AuraxPay (payments)
  - Optional legacy Render endpoints (historical; Contabo is primary edge)
```

---

## 3. Current VPS (Contabo — Application Edge)

| Item | Evidence |
|------|----------|
| **IP** | `144.91.117.90` (+ IPv6 `2a02:c207:2338:657::1`) |
| **Hostname** | `vmi3380657` |
| **OS** | Ubuntu 24.04.4 LTS (Noble), kernel `6.8.0-139-generic` |
| **CPU** | 4 vCPU — AMD EPYC (QEMU) |
| **RAM** | 7.8 GiB total (~643 MiB used at inventory time) |
| **Disk** | `/dev/sda1` ext4 **145G**, ~18G used (13%) |
| **Swap** | none |
| **Node.js** | `v22.22.3` |
| **npm** | `10.9.8` |
| **PM2** | `7.0.1` |
| **Nginx** | `1.24.0 (Ubuntu)` |
| **Docker** | not installed |
| **UFW** | active; allow 22/80/443 only |
| **fail2ban** | inactive / unavailable |

### PM2 processes (Osmani-relevant)

| Name | Status | Script | CWD | Listen |
|------|--------|--------|-----|--------|
| `osmani-admin-api` | online | `/var/www/osmani-admin-api/server/src/index.js` | `/var/www/osmani-admin-api/server` | `*:10001` |
| `osmani-tv-backend` | online | `/var/www/osmani-tv/backend/server.js` | `/var/www/osmani-tv/backend` | `0.0.0.0:10000` |

**Note:** Path is `/var/www/osmani-tv/backend` (not `/var/www/osmani-tv-backend`). PM2 process name remains `osmani-tv-backend`.

### Git checkouts on Contabo

| Path | Remote | Branch / commit (at inventory) |
|------|--------|--------------------------------|
| `/var/www/osmani-admin-api` | `https://github.com/sokalive/osmani-admin.git` | `main` @ `500c749` (runtime health reported API commit `e8eb372`) |
| `/var/www/osmani-tv` | `https://github.com/sokalive/osmani-tv.git` | commit `787e61b` |
| `/var/www/osmanitv.com` | Public web SPA static root | — |
| `/var/www/osmani-tv-backup-before-contabo-cutover` | Historical backup tree | Do not treat as live |

---

## 4. Vultr Resources

| Field | Value (from authenticated Vultr UI) |
|-------|-------------------------------------|
| **Label** | `osmani-tv` |
| **Status** | Running |
| **Public IPv4** | `155.138.223.205` |
| **Region / Location** | Atlanta |
| **OS** | Ubuntu 24.04 LTS x64 |
| **Billing snippet visible** | ~`$1.96` (UI fragment; exact plan size not fully captured without deeper config pages) |
| **Role confirmed** | Hosts PostgreSQL endpoint used by Contabo apps |

**Not confirmed in this pass (UI limited / not opened):** exact plan SKU (vCPU/RAM GB), IPv6, attached block storage list, snapshot schedule details, firewall group names. Deeper Vultr config pages were intentionally avoided beyond visibility of the instance.

**Architecture conclusion:** Vultr `osmani-tv` is the **database host** (and possibly more services on that box). Contabo is the **public application/edge host**. This fragmentation is the primary operational complexity.

---

## 5. PostgreSQL Location

| Field | Value |
|-------|-------|
| **Provider** | Self-hosted PostgreSQL on Vultr Cloud Compute (`osmani-tv`) — **not** Contabo-local; **not** confirmed as Vultr Managed DB product |
| **Host** | `155.138.223.205` |
| **Port** | `5432` |
| **Database** | `osmani_db` |
| **DB user (name only)** | `osmani_db_user` |
| **Password** | `[REDACTED]` |
| **Version** | **18.4** (`Ubuntu 18.4-1.pgdg24.04+1`) |
| **Region** | Atlanta (Vultr instance location) |
| **Connection architecture** | Contabo Node apps open outbound TCP to Vultr PG; `inet_server_addr()` returns `155.138.223.205` |

Consumers of this DB (confirmed via env/process config shape):
- `osmani-admin-api` on Contabo
- `osmani-tv-backend` on Contabo (env key `DATABASE_URL` present)

---

## 6. Database Schema / Critical Tables

**Schema:** `public`  
**Table count:** **58** base tables

### Critical tables (metadata only)

| TABLE | PURPOSE | PRIMARY KEY | Approx rows | MIGRATION IMPORTANCE |
|-------|---------|-------------|-------------|----------------------|
| `device_subscriptions` | Authoritative device entitlement (`status`, `expires_at`, txn link) | `device_id` | 1429 | **CRITICAL** |
| `transactions` | Payment/order lifecycle, phone, plan, device, recovery | `id` | 2728 | **CRITICAL** |
| `plans` | Package catalog (price, duration) | `id` | 13 | **CRITICAL** |
| `manual_subscription_grants` | Admin manual gifts / custom expiry | `id` | 138 | HIGH |
| `device_phone_registry` | Device ↔ phone binding | composite-ish (`device_id`…) | 821 | HIGH |
| `device_intelligence_registry` | Device intelligence / block status | `id` | 5890 | HIGH |
| `subscriptions` | Legacy phone-keyed subscription row | `phone` | 1 | MEDIUM (legacy) |
| `channels` | App channel catalog + instruction videos meta | `id` | 20 | HIGH |
| `banners` | Promo banners | `id` | 3 | MEDIUM |
| `app_settings` | Key/value app runtime config | `key` | 45 | HIGH |
| `payment_providers` | Enabled payment providers | `id` | 4 | HIGH |
| `sonicpesa_settings` / `zenopay_settings` / `auraxpay_settings` / `checkout_payment_settings` | Provider config | `id` | 1 each | HIGH |
| `payment_transactions` | Alternate/legacy payment txn store | `id` | 0 | LOW (empty) |
| `admin_panel_users` | Admin login identities | `id` | 1 | HIGH |
| `admin_panel_trusted_devices` | Trusted devices + `trusted_expires_at` (14d) | `id` | 1 | HIGH |
| `admin_panel_sessions` | Admin session JTI revocation | `id` | 1 | HIGH |
| `admin_panel_login_otps` | Admin OTP challenges (hashed) | `id` | 48 | MEDIUM |
| `admin_panel_security_events` | Admin security audit | `id` | 6 | MEDIUM |
| `security_events` | Broader security log stream | `id` | 199 | MEDIUM |
| `notifications` / SMS / offer / transfer tables | Ops features | varies | — | MEDIUM |

### Live subscription snapshot (counts only)

| Metric | Count |
|--------|------:|
| Active valid (`status='active'` AND `expires_at > now()`) | **135** |
| Expired / past `expires_at` | **1213** |

### Key relationships (FK evidence)

- Admin auth: `admin_panel_*` → `admin_panel_users` / `admin_panel_trusted_devices`
- Commerce: `transactions.plan_id` → `plans`; `subscriptions.plan_id` → `plans`; `manual_subscription_grants.plan_id` → `plans`
- Entitlement authority for app access is primarily **`device_subscriptions`** keyed by `device_id` with `expires_at` + `transaction_id`

---

## 7. User + Package Data Flow

Osmani consumer identity is **device-centric**, not a classic `users` table:

1. **Device appears** → rows in `device_intelligence_registry` / `device_phone_registry` / installs telemetry.
2. **Package purchase** → `transactions` (+ provider webhook inbox/settings) referencing `plans`.
3. **Entitlement activation** → upsert/update `device_subscriptions` (`status`, `started_at`, `expires_at`, `transaction_id`).
4. **Access checks** → Admin API / TV backend evaluate `device_subscriptions.expires_at` (and block/revoke flags).
5. **Manual ops** → `manual_subscription_grants` and Admin tools can grant/extend without changing historical payment rows incorrectly.
6. **Phone-oriented legacy** → `subscriptions(phone)` exists but is nearly unused (1 row) vs device subscriptions (1429).

**What must be preserved for zero-data-loss:**
- All `device_subscriptions` rows (especially future `expires_at`)
- All `transactions` + reconciliation/webhook inbox state
- `plans` catalog
- Device↔phone registry and intelligence registry where used for support/security
- Manual grant history

---

## 8. Payment Architecture

| Element | Evidence |
|---------|----------|
| Providers configured in DB | SonicPesa, ZenoPay, AuraxPay settings tables + `payment_providers` (4) + `checkout_payment_settings` |
| Primary ledger | `transactions` (2728 rows) |
| Webhook / reconcile workers | Admin API env includes SonicPesa inbox/reconcile timers (`SONICPESA_*`) |
| Public webhook base | Contabo `https://api.osmanitv.com` (payment webhooks must keep domain stable) |
| SMS / alerts | Beem + Admin alert email (Resend) — keys `[SECRET PRESENT]` |

**Migration note:** After IP change, **DNS for `api.osmanitv.com` must remain the webhook target** (or provider dashboards must be updated). Prefer keeping domain → new VPS rather than changing provider URLs mid-cutover.

Env names (values redacted): `BEEM_API_KEY`, `BEEM_SECRET_KEY`, SonicPesa/ZenoPay/Aurax keys in DB settings tables, `ONESIGNAL_*`, `RESEND_API_KEY`.

---

## 9. Authentication Architecture

### App / device side
- Device IDs + fingerprints; subscription entitlement via DB.
- Security challenge / verification tables present (`security_verification_challenges`, profiles, anomalies).
- No classic end-user password table found (`users`/`customers` tables absent).

### Admin panel (production-verified contract)
Documented and enforced in Contabo Admin API:

| Step | Behavior |
|------|----------|
| New device | Email + Admin PIN → OTP (Resend) → verify → enroll trusted device + session |
| Trusted device | Cryptographic device credential + fingerprint; DB hash authority |
| Trust window | **Exactly 14 days** (`trusted_expires_at`, non-sliding) |
| Restore | `GET /api/admin/auth/session` re-issues session while trust valid |
| Logout | Ends session; should not destroy trusted-device enrollment (credential retained) |
| Block / Revoke / Delete | Immediate credential/session invalidation; delete hard-removes row after invalidate |
| Cookies | HttpOnly session + device cookies (SameSite=Lax; Secure on HTTPS); header fallback for cross-origin SPA |

Secrets (names only): `ADMIN_JWT_SECRET`, `ADMIN_LOGIN_PIN`, `ADMIN_SECURITY_PIN`, `ADMIN_DEVICE_*` salts if set, OTP hash salts, Resend key.

---

## 10. Admin Security Architecture

| Control | Location |
|---------|----------|
| Security Center gate | PIN + email OTP → gate JWT for device APIs |
| Trusted devices UI | Admin SPA `/admin-security` → `/api/admin/auth/devices*` |
| Audit | `admin_panel_security_events`, `security_events` |
| Panel auth required | `ADMIN_PANEL_AUTH_REQUIRED=true` (health/`/status` confirmed) |

---

## 11. Storage / Media

| Store | Path / URL | Notes |
|-------|------------|-------|
| Local uploads (authoritative for Admin media) | `/var/www/osmani-admin-api/server/uploads` (~**211 MB**) | Served via Nginx → Node `/uploads/` |
| Admin SPA build | `/var/www/osmani-admin-api/dist` (~1.6 MB) | |
| Public web SPA | `/var/www/osmanitv.com` (~1.2 MB) | |
| CDN | `https://osmanitv.b-cdn.net` (`BUNNY_CDN_BASE_URL`) | External; recreate/repoint, not “move DB” |
| Channel/banner binaries | Often under uploads + CDN URLs in DB columns | Migrate files + URL consistency |

**Must copy on migration:** entire `server/uploads` tree (+ any APK/instruction videos referenced by settings/channels).

---

## 12. Domains / DNS

| DOMAIN | DNS target (getent) | Server | Purpose |
|--------|---------------------|--------|---------|
| `admin.osmanitv.com` | `144.91.117.90` | Contabo Nginx → SPA + `/api` → `:10001` | Admin panel |
| `api.osmanitv.com` | `144.91.117.90` | Contabo Nginx → `:10001` | Public/mobile API + webhooks + uploads |
| `osmanitv.com` | `144.91.117.90` | Contabo Nginx → `/var/www/osmanitv.com` | Marketing/web SPA |
| `www.osmanitv.com` | configured in Nginx (HTTPS vhost) | Contabo | Alias of main site |
| `admin.osmani.tv` | listed on HTTP default server_name | Contabo | Legacy/alternate name on `:80` default |

**TLS:** Let's Encrypt live cert name `osmanitv.com` (SAN covers branded hosts). Paths: `/etc/letsencrypt/live/osmanitv.com/`.

**Do not change DNS during inventory.** Future migration: point same names to **new VPS IP** after cutover readiness.

---

## 13. Environment Variables

### `osmani-admin-api` (`/var/www/osmani-admin-api/server/.env`) — names only

`DATABASE_URL`, `BASE_URL`, `STREAM_API_BASE_URL`, `ADMIN_PUBLIC_URL`, `UPLOAD_DIR`, `BUNNY_CDN_BASE_URL`, `NOTIFICATION_IMAGE_PUBLIC_ORIGIN`, `INSTRUCTION_VIDEO_PUBLIC_ORIGIN`,  
Admin auth: `ADMIN_PANEL_AUTH_REQUIRED`, `ADMIN_JWT_SECRET`, `ADMIN_LOGIN_PIN`, `ADMIN_SECURITY_PIN`, `ADMIN_LOGIN_EMAILS`, `ADMIN_PANEL_BOOTSTRAP_*`, `ADMIN_ALERT_EMAIL`, `ADMIN_TRUSTED_DEVICE_DAYS`, `ADMIN_SESSION_TTL_SECONDS`, `ADMIN_SESSION_COOKIE_DAYS`, `ADMIN_DEVICE_COOKIE_DAYS`, OTP tuning vars,  
Integrations: `RESEND_*`, `ONESIGNAL_*`, `BEEM_*`,  
Ops: `ADMIN_API_TOKEN`, `APP_UPDATE_ADMIN_TOKEN`, `MANUAL_SUBSCRIPTION_ADMIN_PIN`, `ANALYTICS_RESET_*`, `TRANSFER_DEBUG_TOKEN`, pool/cache tunables (`PG_POOL_*`, SonicPesa worker timers, etc.)

All values: `[SECRET PRESENT]` / `[CONFIGURED]` as applicable.

### `osmani-tv` backend `.env`
- `DATABASE_URL` only (key name confirmed)

---

## 14. Backups

| Type | Location / Evidence | Notes |
|------|---------------------|-------|
| Filesystem tree backup | `/var/www/osmani-tv-backup-before-contabo-cutover` | Historical Contabo cutover artifact |
| Let's Encrypt / certbot | `/etc/letsencrypt`, cron.d `certbot` | Cert renewal automation |
| Vultr instance backups/snapshots | Not fully enumerated in UI this pass | **Must verify before migration** |
| PostgreSQL dumps | Not found as scheduled root cron on Contabo | **Gap risk** — confirm dump jobs on Vultr host or external |
| Application git | GitHub remotes | Source of truth for code, not DB |

**Risk:** No Contabo root crontab DB dump observed. Before migration, confirm how `osmani_db` is backed up on `155.138.223.205`.

---

## 15. Deployment Architecture

| Piece | Detail |
|-------|--------|
| Admin repo | `sokalive/osmani-admin` → Contabo `/var/www/osmani-admin-api` |
| TV repo | `sokalive/osmani-tv` → Contabo `/var/www/osmani-tv` |
| Deploy scripts | `deploy/contabo/*.sh` (`pull-and-apply.sh`, `apply-cutover.sh`, `upsert-admin-auth-env.sh`, nginx helpers) |
| GitHub Actions | Contabo workflows: deploy, reload-api, pm2-restart-only, upsert-admin-auth-env, diagnostics; also Render workflows (legacy) |
| Runtime | PM2 fork mode; Admin `PORT=10001`; env via `.env` + PM2 env |
| Migrations | Admin API startup `ensureBillingTables()` style DDL (idempotent ALTERs) — **not** a separate Flyway folder |
| Health | `GET /api/health` on `:10001` / `api.osmanitv.com` |

---

## 16. Current Health

| Check | Result |
|-------|--------|
| `osmani-admin-api` PM2 | online |
| `osmani-tv-backend` PM2 | online |
| `http://127.0.0.1:10001/api/health` | `ok`, `startup.ready=true` |
| `https://api.osmanitv.com/api/health` | `ok` |
| `https://admin.osmanitv.com/api/admin/auth/status` | `panelAuthRequired=true` |
| PostgreSQL reachability from Contabo | confirmed (metadata queries succeeded) |
| Vultr `osmani-tv` | Running; IP matches DB host |

---

## 17. Migration Dependency Map

| Category | Items |
|----------|-------|
| **MUST MIGRATE** | `osmani_db` full dump/restore; Contabo `server/uploads`; Admin `.env` secrets (recreate securely); TLS issuance for same domains; Nginx vhosts; PM2 process definitions; verified `device_subscriptions`/`transactions`/`plans` integrity |
| **CAN RECREATE** | Node `node_modules`, SPA `dist/` via build, Nginx package install, UFW rules, PM2 install, Let's Encrypt certs |
| **CAN BE RECONFIGURED** | `DATABASE_URL` host if DB moves; pool sizes; CDN origin hosts list; provider webhook URLs if domain/IP strategy changes |
| **MUST REMAIN EXTERNAL (recommended)** | Bunny CDN, Resend, OneSignal, Beem, payment provider SaaS, Google/Apple app stores, GitHub |
| **DO NOT TOUCH** | Nassani/Kitonga/Rahimu; unrelated Contabo/Vultr resources; production data during design |

---

## 18. Zero-Data-Loss Requirements

Must survive cutover unchanged in meaning:

1. All devices with future `device_subscriptions.expires_at`
2. Historical `transactions` + recovery/reconcile state
3. `plans` pricing/duration definitions
4. Manual grants history
5. Admin trusted devices / sessions policy continuity (or planned re-auth)
6. Channel/banner/content rows + upload binaries
7. `app_settings` keys
8. Payment provider settings rows (secrets re-entered carefully)
9. Public domains unchanged (`api`/`admin`/`osmanitv.com`)

**App domain must remain the same; new VPS gets new IP behind DNS.**

---

## 19. Recommended New VPS Architecture

Based on evidence (not executed):

### Preferred consolidation (Aslamu-like cleanliness)
Put on **one new primary VPS**:
- Nginx + TLS
- `osmani-admin-api`
- `osmani-tv` backend (if still required)
- Local uploads
- **PostgreSQL co-located OR dedicated managed PG in same region**

Then **retire Contabo edge** and either:
- **A)** Migrate PG off Vultr `osmani-tv` onto new VPS/managed PG, then decommission `osmani-tv`, **or**
- **B)** Keep PG on Vultr temporarily and only move apps (keeps split-brain latency/ops risk)

**Recommendation:** Prefer **A** long-term (single ownership boundary), with a carefully sequenced dump/restore + read-only verify + DNS flip. Keep payment/email/push external.

### What should stay external
Bunny CDN, Resend, OneSignal, Beem, SonicPesa/ZenoPay/Aurax SaaS.

### Fragmentation today
- Apps on Contabo EU-ish Contabo IP; DB on Vultr Atlanta → cross-provider latency and dual-ops.
- Two git repos / two PM2 apps.
- Legacy Render references still in docs/workflows.
- Backup story for PG unclear from Contabo cron alone.

---

## 20. Migration Risks

| Risk | Severity | Mitigation (design) |
|------|----------|---------------------|
| Split-brain Contabo apps vs Vultr PG | High | Single cutover window; freeze writes; verify row counts |
| Missing automated PG backups | High | Take verified dump **before** any move; test restore on staging |
| Webhook downtime during DNS TTL | High | Lower TTL ahead; keep `api.osmanitv.com` continuous |
| Upload/CDN URL mismatch | Medium | Copy uploads; rewrite only if origins change |
| Admin trusted devices invalidated | Medium | Expect re-OTP after secret/host changes; communicate |
| Accidental touch of unrelated projects | High | Inventory allow-list only; never use Nassani keys |
| PG 18.4 restore to older major | High | Target PG ≥ 18 or use dump compatible pipeline |

---

## 21. Migration Plan — DESIGN ONLY (NOT EXECUTED)

1. **Inventory freeze** — this document.  
2. **Backup** — verified `pg_dump` of `osmani_db`; tarball of Contabo `uploads`; export env names checklist.  
3. **Provision new VPS** — Ubuntu LTS, Node 22, Nginx, PM2, UFW 22/80/443.  
4. **Restore DB** to new PG (or managed) — read-only checksums/counts.  
5. **Deploy apps** from GitHub `main` builds; inject secrets; point `DATABASE_URL` at new DB.  
6. **Shadow test** — health, login OTP, subscription verify, webhook sandbox.  
7. **DNS cutover** — `api`/`admin`/`osmanitv.com` → new IP; monitor webhooks.  
8. **Decommission** Contabo app role; then Vultr DB role when stable.  

**This plan is design-only. Nothing above was executed in this task.**

---

## 22. Critical Final Report Table

| Component | Current Location | Current Host | Port | Data Criticality | Must Migrate | Notes |
|-----------|------------------|--------------|------|------------------|--------------|-------|
| Osmani Admin SPA | Contabo disk `dist/` | `144.91.117.90` | 443 | Medium | Recreate via build | Served by Nginx |
| Osmani Admin API | Contabo PM2 | `144.91.117.90` | 10001 | High | Yes (code+env) | Primary API |
| Osmani TV backend | Contabo PM2 | `144.91.117.90` | 10000 | High | Yes | Path `/var/www/osmani-tv/backend` |
| PostgreSQL | Vultr `osmani-tv` | `155.138.223.205` | 5432 | **Critical** | **Yes** | DB `osmani_db` PG 18.4 |
| Users (devices) | DB tables | Vultr PG | 5432 | Critical | Yes | Device registries |
| Packages | `plans` | Vultr PG | 5432 | Critical | Yes | |
| Subscriptions | `device_subscriptions` | Vultr PG | 5432 | Critical | Yes | 135 active valid |
| Payments | `transactions` + provider settings | Vultr PG | 5432 | Critical | Yes | Webhooks via api domain |
| Media | Contabo uploads | `144.91.117.90` | 443/10001 | High | Yes (files) | ~211MB + CDN |
| Authentication (Admin) | API + DB admin_panel_* | Contabo + Vultr PG | 10001/5432 | High | Yes | 14-day trusted devices |
| Admin Security | Same | Contabo + Vultr PG | — | High | Yes | Gate/OTP/devices |
| DNS | External DNS → Contabo | `144.91.117.90` | — | Critical | Repoint later | Domains stay same |
| SSL | Let's Encrypt on Contabo | `144.91.117.90` | 443 | High | Recreate | `osmanitv.com` cert |
| Backups | Partial / unclear PG dumps | mixed | — | Critical | Establish | Verify Vultr backups |

---

## 23. Files Created

- `docs/OSMANI_PRODUCTION_INFRASTRUCTURE_INVENTORY.md` (this report)

---

## 24. Git

- **Commit:** `2a148df7808686f03bb1e43a2e66dbd38b8077f2`
- **Branch:** `main`
- **Push:** pushed to `origin/main` (`https://github.com/sokalive/osmani-admin.git`)
- **Contents:** documentation only (`docs/OSMANI_PRODUCTION_INFRASTRUCTURE_INVENTORY.md`)
- **Production runtime:** unchanged (no deploy)

---

**End of inventory. No migration performed.**
