# MASTER ADMIN SECURITY SYSTEM SPECIFICATION

**Source of truth:** Osmani Admin production implementation (verified 2026-09-10)  
**Companion report:** `docs/ADMIN_AUTH_SECURITY_INTEGRATION_REPORT.md`  
**Verified functional fix commit:** `a61e7c8`  
**Repository:** `https://github.com/sokalive/osmani-admin.git`  

This document describes the **actual** Admin Security architecture implemented and production-verified for Osmani Admin. It is written so another AI coding agent can reproduce the same architecture in a different Admin/backend project.

**This file contains no production secrets.** Use placeholders such as `<ADMIN_EMAIL>`, `<ADMIN_PIN_SECRET>`, `<SECURITY_PIN_SECRET>`, `<RESEND_API_KEY>`, `<ADMIN_JWT_SECRET>`, `<PRODUCTION_API_URL>`.

---

## 1. PURPOSE

### Security problem solved
Osmani Admin originally shipped a powerful Admin SPA and API while production treated the Contabo install as “trusted,” which:

1. Forced `ADMIN_PANEL_AUTH_REQUIRED=false` (interactive login disabled).
2. Reduced API protection to a shared `X-Admin-Token`.
3. Allowed the SPA to default a missing token to a known value (`3030`).
4. Relied on forgeable browser fingerprint/localStorage as “device identity.”
5. Stored JWTs in `localStorage` without a server-side session revocation table.
6. Allowed Admin Security PIN defaults/fallbacks in code paths.

Anyone who knew or guessed the shared token—or used the SPA default—could call Admin APIs. Device trust was not a real cryptographic credential. Block/delete UI actions were not reliably authoritative end-to-end (including delete paths that re-seeded logs after wipe).

### Why original authentication was insufficient
- **Frontend was effectively the gate** when panel auth was off.
- **Shared token ≠ identity** (no per-admin, per-device proof).
- **No durable trusted-device secret** (IP/UA/fingerprint alone are forgeable).
- **No guaranteed session kill** on block/revoke without server session rows + credential invalidation.
- **Delete could look successful in UI while DB history returned** (audit helpers re-inserted into `security_events`).

### Security objectives of the new system
- **Backend is the ultimate authentication authority.**
- **Frontend must never contain authentication secrets** (login PIN, security PIN, Resend key, JWT secret, device credentials in source).
- **Trusted device** → restore session without repeated OTP every visit.
- **New/unrecognized device** → email + PIN + OTP → register device + issue credential.
- **Admin can list authenticated/trusted devices** with metadata.
- **Admin can block / revoke / delete devices** with server enforcement.
- **Block invalidates active sessions** and rejects future auth from that device.
- **Security Center has an additional gate** (Security PIN + OTP → gate JWT).
- **Security actions enforced server-side** (hiding buttons is not security).
- **Delete means hard delete** when permanent deletion is requested (selected logs; device delete after invalidation).
- **Revoke means invalidate** credentials/sessions (row may remain as `REVOKED` for audit).
- **UI success only after backend confirms** non-zero affected/deleted where applicable.

---

## 2. COMPLETE ARCHITECTURE

```
Admin Frontend (SPA / Mobile)
        │  HTTPS
        ▼
Admin Backend API  (Node / Express — Osmani: osmani-admin-api)
        │
        ├── Authentication / session layer
        │     JWT (jti) + HttpOnly cookies OR Bearer + device credential header
        │     requireAdminPanelAccess middleware
        │
        ├── OTP / email layer (Resend) — server-side only
        │
        └── PostgreSQL
              admin_panel_users
              admin_panel_trusted_devices
              admin_panel_login_otps
              admin_panel_sessions
              admin_panel_security_events
              security_events (operational/security logs UI)
              analytics_reset_challenges (OTP challenges for Security Center / destructive)
```

### Layer responsibilities

| Layer | Responsibility |
|-------|----------------|
| **Frontend** | Collect email/PIN/OTP; send fingerprint; store **only** what backend issues (cookies or secure mobile store); show Security Center UI; never decide trust locally; never toast success without backend confirmation |
| **Backend API** | Validate PIN/OTP; issue/revoke sessions & credentials; enforce gate; perform block/revoke/delete; rate-limit; return authoritative status codes |
| **Database** | Persist users, hashed credentials, hashed OTPs, session JTIs, device status, audit events; hard-delete when requested |
| **Email/OTP** | Deliver 6-digit OTP to `<ADMIN_ALERT_EMAIL>` / admin email via Resend; key never leaves server |
| **Device identity** | Cryptographic **device credential** (hash in DB) + fingerprint hash binding; IP/UA are metadata only |
| **Sessions** | JWT with `jti` row in `admin_panel_sessions`; revoke on logout/block/revoke/delete/wipe |
| **Security Center** | Extra PIN+OTP gate JWT (`X-Admin-Security-Gate`); device management + destructive actions |

---

## 3. ADMIN LOGIN FLOW

### High-level sequence

```
Boot → GET /api/admin/auth/status
     → GET /api/admin/auth/session (credentials include / device credential header)

If authenticated → Admin home
Else → Login (email + PIN + device_fingerprint)
         │
         ├─ trusted ACTIVE device → step: authenticated (session + cookies)
         └─ else → step: otp_required + pendingToken
                      → email OTP
                      → POST /verify-otp
                      → upsert trusted device + rotate credential
                      → session JWT + device credential
```

### Exact Osmani endpoints
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/verify-otp`
- `POST /api/admin/auth/resend-otp`
- `GET /api/admin/auth/session`
- `POST /api/admin/auth/logout`

### Case matrix

| Case | Behavior |
|------|----------|
| **A. First login / new device** | Email+PIN OK → `otp_required` → OTP email → verify → create/upsert device `ACTIVE`, issue `deviceCredential`, session JWT, cookies |
| **B. Trusted ACTIVE device** | Email+PIN OK + known fingerprint + valid path → `step: authenticated` **without OTP** (production-verified) |
| **C. Invalid PIN** | `401`; audit failure; rate limit toward `429` |
| **D. Invalid OTP** | `401`; attempt counter; lockout after max fails |
| **E. Expired OTP** | `401`; must resend / new login |
| **F. Reused OTP** | OTP marked `used=true` after success; reuse fails |
| **G. Blocked device** | Login returns `403` `DEVICE_BLOCKED`; session endpoints reject |
| **H. Revoked device** | Credential cleared; status `REVOKED`; auth fails (`DEVICE_REVOKED` / unauthenticated) |
| **I. Revoked session** | `admin_panel_sessions.revoked_at` set or `session_version` mismatch → `401 SESSION_REVOKED` |

---

## 4. TRUSTED DEVICE SYSTEM

### What “remembering a device” means
The server remembers a device as a row in `admin_panel_trusted_devices` keyed by `(admin_user_id, device_fingerprint_hash)` and authenticated by a **server-issued device credential** whose **hash** is stored in `device_credential_hash`.

### Identity components — do not confuse them

| Concept | Role | Trust authority? |
|---------|------|------------------|
| **Device fingerprint** | Stable client-generated install/browser id (hashed server-side). Binds which device row. Sent as `device_fingerprint` / `X-Admin-Device-Fingerprint`. | **No** — forgeable alone |
| **Device credential** | Cryptographically random secret (`crypto.randomBytes(32)` base64url). Issued after OTP. Hash stored in DB. Cookie `osmani_admin_device` or header `X-Admin-Device-Credential`. | **Yes — primary trust secret** |
| **Session token (JWT)** | Short/long-lived access proof with `jti` (+ optional `sv` session_version). Cookie `osmani_admin_session` or `Authorization: Bearer`. | Session proof, not device enrollment |
| **IP address** | Metadata / geo display / rate-limit key | **Never** sole identity |
| **Browser / User-Agent** | Metadata (device type, OS, browser parsing) | **Never** sole identity |

### Why IP and UA must not be sole identity
They change (NAT, mobile networks, browser updates), are trivial to spoof, and are shared by many users. Treating them as trust proof enables impersonation and false lockouts.

### Lifecycle

| Event | Server behavior |
|-------|-----------------|
| **Register** | After successful OTP: upsert device row, set `status=ACTIVE`, store credential hash, geo/UA fields, bump session_version when credential rotates |
| **Generate credential** | `generateAdminDeviceCredential()` → random 32 bytes |
| **Store** | Only `SHA-256(salt::plain)` in DB (`ADMIN_DEVICE_CREDENTIAL_SALT`) |
| **Protect** | Plaintext only in HttpOnly cookie or mobile secure store; never logged |
| **Validate** | On session: load device by fingerprint/credential; check status not BLOCKED/REVOKED; check session jti not revoked; check session_version |
| **Revoke** | Soft: `status=REVOKED`, clear credential hash, bump `session_version`, revoke sessions |
| **Block** | `status=BLOCKED`, clear credential, bump version, revoke sessions; login rejected |
| **Hard delete** | Invalidate as revoke/block, then `DELETE` device row |
| **Browser/app restart** | Web: cookies restore; Mobile: send stored credential + fingerprint to `/session` |
| **Logout** | Revoke current (or global) session jti(s); clear cookies; mobile must wipe local credential/token |
| **After block/delete** | Old JWT/credential fail; must not silently re-auth |

---

## 5. DEVICE STORAGE / SECURITY

### Web (Osmani SPA)
Cookies:

| Cookie | Contents | Flags |
|--------|----------|-------|
| `osmani_admin_session` | Session JWT | `HttpOnly`, `SameSite=Lax`, `Secure` when HTTPS |
| `osmani_admin_device` | Device credential plaintext | same |

`credentials: 'include'` on admin fetches.

**Do not** store device credential or JWT in `localStorage` as the primary trust store (XSS-readable).

### Mobile
- Store `deviceCredential` in **EncryptedSharedPreferences / Android Keystore-backed storage** (or iOS Keychain equivalent).
- Send `X-Admin-Device-Credential` + `X-Admin-Device-Fingerprint` (+ Bearer JWT if used).
- Never: plaintext SharedPreferences, plaintext files, hardcoded credentials, embedding PINs/Resend keys.

---

## 6. OTP SYSTEM

### When OTP is required
- New device / unrecognized fingerprint.
- Device `force_otp_next` / status `NEW`.
- Security Center gate (`admin_security_gate`).
- Destructive Security Center actions (`admin_security_destructive`).

### When OTP is NOT required
- Device already `ACTIVE` trusted and login PIN succeeds (production-verified `step: authenticated`).
- Valid session restore via `/session` with valid cookies/credential.

### Architecture (login OTP)
1. Generate 6-digit OTP.
2. Store **hash only** in `admin_panel_login_otps` (`code_hash`, `expires_at`, `used`).
3. Email via Resend to configured admin/alert address.
4. Verify: hash match, not expired, not used → mark used.
5. Failures increment counters; lockout → `429`.
6. Resend throttled (`429` when too soon / too many).

### Security Center / destructive OTP
Uses challenge table `analytics_reset_challenges` with `purpose`:
- `admin_security_gate`
- `admin_security_destructive`

Properties (from store): challenge TTL ~15 min, OTP TTL ~5 min, max verify attempts, max sends, min resend gap.

### Email provider
Conceptual: server calls Resend with `<RESEND_API_KEY>` and `<RESEND_FROM_EMAIL>`.

### Absolute rule
```
RESEND API KEY = SERVER-SIDE SECRET ONLY
```
Never expose in frontend, mobile app, browser bundle, GitHub, API responses, or logs.

Also never log: OTP codes, PINs, JWTs, device credential plaintext, JWT secrets.

---

## 7. SECURITY CENTER

### Flow
```
Authenticated Admin session
  → Admin Security page
  → Security PIN (env: ADMIN_SECURITY_PIN)  [user-entered, never hard-coded]
  → OTP to ADMIN_ALERT_EMAIL
  → gateToken (JWT typ admin_security_gate)
  → send as X-Admin-Security-Gate
  → device list / block / revoke / delete / destructive actions
```

### Why a separate gate
Device management can lock out admins and wipe security history. A second factor (PIN + email OTP) reduces risk if a session cookie is stolen but attacker lacks Security PIN + mailbox access.

### Backend verification
- `verifyAdminSecurityPin(pin)` against server env (fail-closed if unset).
- Gate middleware `requireAdminSecurityPageGate` rejects without valid gate JWT → `403 SECURITY_GATE_REQUIRED`.
- Mutations often also re-check Security PIN in body (`requireAdminSecurityPin`).

### Gate representation
Short-lived JWT in header `X-Admin-Security-Gate` (not a substitute for admin session).

---

## 8. DEVICE MANAGEMENT

### A. View devices
`GET /api/admin/auth/devices` (session + gate)

Typical fields shown / returned:
- device name, type, OS, browser
- IP, country, region, city, ISP (from approximate IP geolocation)
- first seen / created, last used, last login
- status: `ACTIVE` | `NEW` | `BLOCKED` | `REVOKED`

**IP geolocation is approximate** — display as informational only.

### B. Trust device
Enrollment happens via successful OTP verify (upsert to `ACTIVE` + credential). There is no separate “trust” API that bypasses OTP for unknown devices.

### C. Block device
`POST /api/admin/auth/devices/:id/block`  
Body may include `security_pin`, `confirm_current_device` if acting on current device.

Effects (verified):
1. `status=BLOCKED`, `blocked=true`, `blocked_at`
2. `device_credential_hash = NULL`
3. `session_version += 1`
4. Sessions for device revoked
5. Existing `/me` → `401 SESSION_REVOKED` (or blocked codes on other paths)
6. Future `/login` → `403 DEVICE_BLOCKED`

### D. Unblock device
`POST .../devices/:id/unblock`  
Sets unblocked/`ACTIVE` but sets **`force_otp_next=true`** and clears credential path as implemented — device must re-authenticate with OTP before becoming fully trusted again.

### E. Revoke device (soft)
`POST .../devices/:id/revoke` or destructive `revoke_devices`

- Status `REVOKED`, credential cleared, sessions invalidated
- **Row remains** for audit visibility
- Differs from block: block is “deny this device until unblock”; revoke is “kill trust permanently (row kept)”

### F. Delete device (hard)
`DELETE .../devices/:id` or destructive `delete_devices`

1. Invalidate credential + sessions (same as revoke path)
2. **Hard DELETE** database row
3. Old credential cannot be reused; next appearance is a new enrollment + OTP

**Do not confuse deleting a DB row with forgetting to invalidate credentials — invalidate first (or atomically), then delete.**

---

## 9. BLOCK ENFORCEMENT

Frontend button is **not** authority.

```
UI Block
  → POST /devices/:id/block (session + gate + security pin)
  → authorize admin + gate
  → UPDATE device BLOCKED + clear credential + bump session_version
  → revoke admin_panel_sessions for device
  → subsequent requireAdminPanelAccess / attachAdminReq rejects
  → login rejects DEVICE_BLOCKED
```

### Expected error codes (verified)
| Code | HTTP | Meaning |
|------|------|---------|
| `DEVICE_BLOCKED` | 403 | Device blocked; cannot auth |
| `SESSION_REVOKED` | 401 | Session jti revoked / version mismatch |
| `DEVICE_REVOKED` | 403 | Device revoked / credential invalid |
| `SECURITY_GATE_REQUIRED` | 403 | Missing/invalid Security Center gate |
| `FORCE_OTP` | 403 | Must re-verify OTP |
| `CONFIRM_CURRENT_DEVICE` | (special) | Must confirm acting on own device |

Other Admin implementations must reproduce **database state change + session invalidation + login rejection**, not only a UI badge.

---

## 10. SESSION MANAGEMENT

### Creation
After login (trusted) or OTP verify: sign JWT (`ADMIN_JWT_SECRET`, HS256) with `jti`, insert `admin_panel_sessions`, set cookies.

### Persistence / restoration
- Web: HttpOnly cookies on `/session`
- Mobile: Bearer + device credential header on `/session`

### Expiration
`ADMIN_SESSION_TTL_SECONDS` (Osmani default up to 30 days, minimum floor in code).

### Revocation
- Logout current jti
- Logout `global: true` → revoke all user sessions
- Block / revoke / hard-delete device → revoke device sessions
- `delete_all_security_logs` → `DELETE FROM admin_panel_sessions` (all admin sessions)

### Distinguishing states

| State | How server knows |
|-------|------------------|
| Valid session | JWT ok, jti row exists, `revoked_at` null, device ACTIVE, version matches |
| Invalid/expired JWT | signature/exp fail → `INVALID_SESSION` / `NO_SESSION` |
| Revoked session | `revoked_at` set or version mismatch → `SESSION_REVOKED` |
| Blocked device | device status/flag → `DEVICE_BLOCKED` |
| Revoked device | status REVOKED / no credential → `DEVICE_REVOKED` |

---

## 11. DELETE AI SESSIONS / SECURITY LOGS

### Original bug
Delete wiped `security_events` then **audit helpers re-inserted** events (e.g. “OTP sent”), so refresh made delete look broken.

### Corrected behavior (verified)
| Action | API | DB |
|--------|-----|-----|
| Delete selected logs | `POST /api/security-logs/bulk-delete` `{ ids: [...] }` | Hard `DELETE WHERE id = ANY(...)`; **404 if 0 rows**; **no reseed** |
| Delete all sessions/logs | destructive `delete_all_security_logs` | Hard delete `security_events` + `admin_panel_security_events` + `admin_panel_sessions`; **no write-back into security_events** |

After delete:
- UI list must refetch from API
- Refresh / logout-login / direct GET must not return deleted IDs
- Persistence is database, not React state

### DELETE vs REVOKE vs BLOCK

| Operation | Target | Record remains? | Auth effect |
|-----------|--------|-----------------|-------------|
| **DELETE** (logs) | Selected security log rows | **No** (hard delete) | N/A |
| **DELETE** (device) | Device row | **No** after invalidate | Sessions/credential dead |
| **REVOKE** (device) | Device trust | **Yes** as `REVOKED` | Sessions/credential dead |
| **BLOCK** (device) | Device access | **Yes** as `BLOCKED` | Sessions dead; login denied until unblock |

### Multi-select
Client sends **only selected IDs**. Server deletes `WHERE id = ANY($ids)`. Never interpret empty selection as “delete all” unless a separate explicit `delete_all_*` action with confirmation + OTP.

---

## 12. AUDIT / SECURITY LOGGING

### Record (examples)
- login success / failure (PIN)
- OTP sent / verified / failed
- new device / trusted device
- device block / unblock / revoke / delete
- Security Center PIN/OTP success/failure
- destructive action start/execute
- session revoke / security logs cleared

Prefer durable `admin_panel_security_events` for admin security audit. Operational `security_events` powers Admin log UIs.

### Must NEVER log
- PINs, OTPs, API keys, raw device credentials, session secrets, JWT secrets, passwords

### Permanent deletion vs audit
Administrator-requested wipe of session/log history is an explicit destructive action. After wipe, **do not automatically reseed** the same table being wiped. If audit is required post-wipe, write only to a separate durable table that is not the wiped history feed (Osmani: avoid writing back into `security_events` during wipe path).

---

## 13. RATE LIMITING / ABUSE PROTECTION

Osmani uses **in-memory per-process** buckets + temporary locks (not a substitute for edge WAF, but required app-layer protection):

| Surface | Protection |
|---------|------------|
| Login | Per-IP attempt window; lock → `429` (~25 / 15 min then lock) |
| OTP verify | Fail counter; lock minutes configurable (`ADMIN_OTP_MAX_VERIFY_FAIL`, `ADMIN_OTP_LOCK_MINUTES`) |
| OTP resend | Challenge send limits + min resend gap → `429` |
| Security PIN / Security OTP | Same challenge/OTP limits; failed PIN audited |
| Device registration | Gated behind successful OTP after rate-limited login |

Clients must respect `429` and show wait messaging—never busy-loop OTP.

---

## 14. API CONTRACT

Base: `/api/admin/auth`  
Auth: cookies preferred; or `Authorization: Bearer` + `X-Admin-Device-Fingerprint` + optional `X-Admin-Device-Credential`.  
Security Center: add `X-Admin-Security-Gate: <gateToken>`.

| Method | Endpoint | Auth | Body / notes | Success | Key errors |
|--------|----------|------|--------------|---------|------------|
| GET | `/status` | none | — | `{ ok, panelAuthRequired }` | — |
| GET | `/session` | cookie/cred | — | `{ ok, authenticated, ... }` | `DEVICE_BLOCKED` |
| POST | `/login` | none | `{ email, pin, device_fingerprint, device_name?, browser? }` | `authenticated` or `otp_required`+`pendingToken` | `401`, `403 DEVICE_BLOCKED`, `429` |
| POST | `/verify-otp` | pending | `{ pendingToken, code, device_fingerprint, ... }` | `{ ok, token, deviceCredential, isNewDevice }` | `401`, `429` |
| POST | `/resend-otp` | pending | `{ pendingToken, device_fingerprint }` | `{ ok }` | `429` |
| GET | `/me` | session | — | `{ ok, email, device }` | `401/403` |
| POST | `/refresh` | session | — | `{ ok, token }` | `401/403` |
| POST | `/logout` | session | `{ global?: boolean }` | `{ ok }` + clear cookies | — |
| POST | `/admin-security/verify-pin` | session | `{ security_pin }` | `{ challengeToken, maskedEmail }` | `403` |
| POST | `/admin-security/resend-otp` | session | `{ challengeToken }` | `{ ok }` | `429` |
| POST | `/admin-security/verify-otp` | session | `{ challengeToken, otp }` | `{ gateToken }` | `403` |
| GET | `/devices` | session+gate | — | `{ devices: [...] }` | `SECURITY_GATE_REQUIRED` |
| POST | `/devices/:id/block` | session+gate+pin | `{ confirm_current_device? }` | `{ ok }` | `404`, confirm current |
| POST | `/devices/:id/unblock` | session+gate+pin | — | `{ ok }` | `404` |
| POST | `/devices/:id/revoke` | session+gate+pin | — | `{ ok }` | soft revoke |
| DELETE | `/devices/:id` | session+gate+pin | — | `{ ok }` | hard delete after invalidate |
| POST | `/devices/:id/force-otp` | session+gate+pin | — | `{ ok }` | forces next OTP |
| POST | `/admin-security/destructive/start` | session+gate+pin | `{ action, deviceIds? }` | `{ challengeToken, action }` | actions below |
| POST | `/admin-security/destructive/resend-otp` | session+gate | `{ challengeToken }` | `{ ok }` | `429` |
| POST | `/admin-security/destructive/execute` | session+gate+OTP | `{ challengeToken, otp, confirm_current_device? }` | `{ ok, affected/deleted, ... }` | `409` if 0 affected |

**Destructive `action` values (actual):**
- `revoke_devices` — soft revoke selected IDs
- `delete_devices` — hard delete selected IDs
- `delete_all_security_logs` — wipe security history + admin sessions

**Also:**
- `POST /api/security-logs/bulk-delete` `{ ids: [...] }` — hard delete selected logs; `{ ok, deleted }`; `404` if none

Do **not** invent additional endpoints. Adapt names only if your project’s routing prefix differs; preserve semantics.

---

## 15. ERROR CONTRACT

| Code | HTTP | Client reaction |
|------|------|-----------------|
| `NO_SESSION` / `INVALID_SESSION` | 401 | Send to login; clear local session |
| `SESSION_REVOKED` | 401 | Wipe secrets; force login |
| `DEVICE_BLOCKED` | 403 | Wipe secrets; show blocked; do not retry old credential |
| `DEVICE_REVOKED` | 403 | Wipe secrets; force full re-enroll |
| `DEVICE_MISMATCH` | 401 | Resend fingerprint; re-login |
| `FORCE_OTP` | 403 | Run OTP flow again |
| `SECURITY_GATE_REQUIRED` | 403 | Open Security Center PIN+OTP gate |
| `CONFIRM_CURRENT_DEVICE` | (app-specific status) | Ask user to confirm acting on current device |
| Login/OTP invalid | 401 | Show error; do not reveal which field beyond safe messaging |
| Rate limit | 429 | Back off; show wait |
| Destructive 0 rows | 409 | Show failure/no-op — **not** success |

---

## 16. FRONTEND IMPLEMENTATION

Required surfaces:
1. **Login page** — email + PIN; send fingerprint; handle `authenticated` vs `otp_required` vs `DEVICE_BLOCKED`.
2. **OTP page** — 6-digit; resend with cooldown; on success store credential (cookie automatic on web).
3. **Boot restore** — `/status` + `/session` before rendering Admin.
4. **Admin Security entry** — only after normal session.
5. **Security Center gate UI** — PIN → OTP → store gate token in memory (prefer not long-term localStorage).
6. **Device table** — status badges; refresh from API after mutations.
7. **Confirmations** — Block / Revoke / Delete with accurate selected counts (“Delete N selected … permanently?”).
8. **Loading / error / success** — success only if `ok` and `deleted/affected > 0` when counts apply.
9. **Never** filter-deleted rows only in React and claim persistence.

Osmani files of record:
- `src/pages/AdminLoginPage.jsx`, `AdminOtpPage.jsx`, `AdminSecurityPage.jsx`
- `src/context/AdminAuthContext.jsx`
- `src/lib/api.js`, `src/lib/adminSessionStorage.js`

---

## 17. MOBILE APP HANDOFF

```
First launch → GET /session
  authenticated? → home
  DEVICE_BLOCKED? → wipe → blocked screen
  else → login

Login → POST /login
  authenticated → save token → home
  otp_required → OTP → verify-otp → save deviceCredential securely → home
  DEVICE_BLOCKED → wipe → blocked

Cold start later → GET /session with credential + fingerprint
  → no unnecessary OTP if trusted ACTIVE

On DEVICE_BLOCKED | DEVICE_REVOKED | SESSION_REVOKED
  → wipe local auth material → force login → never bypass backend
```

Secure storage mandatory. No hardcoded PINs/keys. Contract verified on production commit `a61e7c8`.

---

## 18. SECURITY THREAT MODEL

### Protects against
- Unauthorized Admin API use without email+PIN(+OTP)
- Unknown device silent access
- Stolen JWT after block/revoke (session table + version)
- Brute-force login/OTP (rate limits)
- Frontend-only fake block/delete
- Source inspection / leaked SPA bundles exposing shared tokens (removed)
- Stale UI claiming delete succeeded while DB still has rows

### Does NOT protect against
- Full root/VPS compromise (env secrets readable)
- Compromised admin mailbox (OTP interception)
- Compromised device with valid credential before revocation
- Physical access to unlocked authenticated workstation
- Malicious insider with Security PIN + email + session

Do not claim absolute security.

---

## 19. PRODUCTION VERIFICATION

Production VPS verification 2026-09-10, runtime commit `a61e7c8`, marker `ALL_DELETE_REVOKE_BLOCK_TESTS_PASS`.

| Test | Result | What was verified |
|------|--------|-------------------|
| Delete single | **PASS** | DB row gone; list API absent |
| Delete multiple | **PASS** | Only selected removed |
| Revoke device | **PASS** | DB `REVOKED` + null credential; `/me` → `SESSION_REVOKED` |
| Block device | **PASS** | Block API ok |
| Existing session after block | **PASS** | `401 SESSION_REVOKED` |
| Re-login after block | **PASS** | `403 DEVICE_BLOCKED` |
| Hard delete device | **PASS** | Row `COUNT=0`; old session 401 |
| Trusted device without OTP | **PASS** | `step: authenticated` |
| Security Gate | **PASS** | `/devices` without gate → `SECURITY_GATE_REQUIRED` |
| Direct API enforcement | **PASS** | Server-side gate + session checks |
| Refresh / DB persistence | **PASS** | DB source of truth after delete/wipe |
| Delete all logs no reseed | **PASS** | Post-wipe `security_events` total 0 |

**Verdict:** DELETE = VERIFIED · REVOKE = VERIFIED · BLOCK = VERIFIED

---

## 20. PRODUCTION DEPLOYMENT (Osmani — non-secret)

| Item | Value |
|------|-------|
| Admin UI | `https://admin.osmanitv.com` |
| Admin API | `https://api.osmanitv.com` (placeholder form: `<PRODUCTION_API_URL>`) |
| VPS | `144.91.117.90` |
| App path | `/var/www/osmani-admin-api` |
| Process | PM2 `osmani-admin-api` |
| Listen | `127.0.0.1:10001` |
| Nginx | serves `dist/` + proxies `/api` → Node |
| DB | PostgreSQL via `DATABASE_URL` (server env) |
| Secrets | `server/.env` via upsert script — **never committed** |

Env strategy (names only):
`ADMIN_PANEL_AUTH_REQUIRED=true`, `ADMIN_TRUSTED_INSTALL=0`, `ADMIN_PANEL_LEGACY_TOKEN_FALLBACK=false`, `ADMIN_PANEL_BOOTSTRAP_EMAIL=<ADMIN_EMAIL>`, `ADMIN_LOGIN_PIN=<ADMIN_PIN_SECRET>`, `ADMIN_SECURITY_PIN=<SECURITY_PIN_SECRET>`, `ADMIN_ALERT_EMAIL`, `RESEND_API_KEY=<RESEND_API_KEY>`, `RESEND_FROM_EMAIL`, `ADMIN_JWT_SECRET=<ADMIN_JWT_SECRET>`, salts for OTP/device credential, `ADMIN_SESSION_TTL_SECONDS`.

---

## 21. FILES / DATABASE / CODE STRUCTURE

### Backend (Osmani)
| Module | Role |
|--------|------|
| `server/src/routes/adminAuth.js` | All auth + Security Center + device routes |
| `server/src/adminAuthStore.js` | DB ops: users, devices, OTPs, sessions, events |
| `server/src/middleware/adminPanelAuthGate.js` | `requireAdminPanelAccess` |
| `server/src/lib/adminAuthCookies.js` | Cookie read/write |
| `server/src/lib/adminDeviceCredential.js` | Generate/hash credential |
| `server/src/lib/adminLoginPin.js` | Login PIN verify |
| `server/src/lib/adminSecurityPin.js` | Security PIN verify (fail-closed) |
| `server/src/lib/adminJwt.js` | JWT sign/verify |
| `server/src/lib/adminOtpChallengeStore.js` | Security/destructive OTP challenges |
| `server/src/lib/resendOtpMail.js` | Email send |
| `server/src/lib/ipGeoLookup.js` | Approximate geo |
| `server/src/routes/deviceSecurity.js` | Security logs CRUD / bulk-delete |
| `server/src/db/billingTables.js` | Ensures admin_* tables/columns |

### Frontend
`AdminLoginPage`, `AdminOtpPage`, `AdminSecurityPage`, `AdminAuthContext`, `api.js`

### Database relationships
```
admin_panel_users 1──* admin_panel_trusted_devices
admin_panel_users 1──* admin_panel_login_otps
admin_panel_users 1──* admin_panel_sessions
admin_panel_trusted_devices 1──* admin_panel_sessions (ON DELETE SET NULL)
admin_panel_users 1──* admin_panel_security_events
security_events — operational log feed (hard-deletable)
```

Important constraints/indexes:
- Unique `(admin_user_id, device_fingerprint_hash)`
- Unique partial index on `device_credential_hash` where not null and not revoked
- Session index on `device_id` / jti lookups

---

## 22. IMPLEMENTATION CHECKLIST FOR OTHER AI AGENTS

- [ ] Investigate existing authentication
- [ ] Identify backend
- [ ] Identify database
- [ ] Implement server-side Admin credentials (email + PIN)
- [ ] Implement OTP (hash, TTL, one-time, email)
- [ ] Implement trusted devices (credential hash ≠ fingerprint)
- [ ] Implement secure session management (jti table + revoke)
- [ ] Implement Security Center gate (PIN + OTP + gate JWT)
- [ ] Implement device listing
- [ ] Implement block (invalidate sessions + credential)
- [ ] Implement unblock (force re-OTP)
- [ ] Implement revoke (soft, keep row)
- [ ] Implement delete (invalidate then hard delete)
- [ ] Implement session/log deletion (hard delete, no reseed)
- [ ] Implement audit events (no secrets in logs)
- [ ] Implement rate limiting
- [ ] Remove secrets from frontend / disable legacy shared-token bypass
- [ ] Test direct API enforcement (no gate → reject)
- [ ] Test refresh persistence
- [ ] Test new device / trusted device / blocked / revoked
- [ ] Test OTP invalid/expired/reuse
- [ ] Test deletion single + multi + wipe
- [ ] Deploy
- [ ] Verify production E2E
- [ ] Push to GitHub
- [ ] Produce final report

---

## 23. REUSABLE IMPLEMENTATION RULES

1. Investigate first; do not invent parallel auth.
2. Backend is the authority.
3. Never hard-code secrets in frontend/mobile.
4. Never trust IP as device identity.
5. Never trust user-agent as device identity.
6. Never use `localStorage` boolean as authentication proof.
7. Never make Block frontend-only.
8. Never make Delete frontend-only.
9. Never report success without backend confirmation (`affected/deleted > 0` when applicable).
10. Never expose OTP/API keys/PINs/credentials in logs or responses.
11. Never commit secrets to GitHub.
12. Test real API behavior (not only UI).
13. Test database persistence after refresh/logout.
14. Test after deployment on the real Admin backend.
15. Never touch unrelated projects/databases.
16. Distinguish DELETE vs REVOKE vs BLOCK clearly in API and UI.
17. After wipe of a log table, do not reseed that same table in the wipe path.
18. Invalidate credentials/sessions before or while removing device rows.

---

## 24. BEFORE VS AFTER

| BEFORE | AFTER |
|--------|-------|
| Panel auth disabled in production | `panelAuthRequired: true` |
| Shared SPA token default | Removed; session/device cookies |
| Fingerprint-as-trust | Cryptographic device credential |
| JWT in localStorage only | HttpOnly cookies + server `admin_panel_sessions` |
| Weak/no session kill | Block/revoke bumps version + revokes jti |
| Delete logs reappeared | Hard delete, no reseed (verified) |
| Device delete = soft only | Soft revoke **or** hard delete (explicit) |
| Security Center PIN fallback risk | Env-only, fail-closed |
| UI-looking security | Production E2E verified |

---

## 25. MASTER IMPLEMENTATION BLUEPRINT

### PHASE 1 — Investigation
- **WHAT:** Map current Admin auth, tokens, env flags, device tables.
- **WHY:** Avoid breaking billing; find fake-open-admin paths.
- **SECURITY:** Identify secrets in frontend bundles.
- **TEST:** Bundle scan for PIN/Resend/token defaults.
- **RESULT:** Written gap analysis.

### PHASE 2 — Database
- **WHAT:** users, trusted_devices (+ credential hash, status, session_version), login_otps, sessions, security_events.
- **WHY:** Durable server authority.
- **SECURITY:** Hash secrets; unique constraints.
- **TEST:** Migrations on staging/prod Admin DB only.
- **RESULT:** Schema ready.

### PHASE 3 — Backend Authentication
- **WHAT:** `/login`, `/session`, `/me`, `/logout`, middleware gate.
- **WHY:** Single authority.
- **SECURITY:** No legacy token bypass in prod.
- **TEST:** Unauthenticated API → 401.
- **RESULT:** Panel requires login.

### PHASE 4 — OTP
- **WHAT:** Issue/verify/resend; Resend integration.
- **WHY:** New-device proof + email possession.
- **SECURITY:** Hash OTP; TTL; one-time; rate limit.
- **TEST:** Invalid/expired/reuse fail.
- **RESULT:** OTP path production-ready.

### PHASE 5 — Trusted Devices
- **WHAT:** Credential issue, cookie/header, ACTIVE path without OTP.
- **WHY:** Usable security without daily OTP spam.
- **SECURITY:** Hash-only storage; fingerprint not trust.
- **TEST:** Trusted re-login `authenticated`; unknown → OTP.
- **RESULT:** Device trust works.

### PHASE 6 — Sessions
- **WHAT:** jti table; revoke; refresh; version checks.
- **WHY:** Kill stolen sessions.
- **SECURITY:** Revoke on block/revoke/logout.
- **TEST:** Revoked jti → `SESSION_REVOKED`.
- **RESULT:** Session control.

### PHASE 7 — Security Center
- **WHAT:** PIN+OTP gate JWT; middleware.
- **WHY:** Elevate privilege for device ops.
- **SECURITY:** Fail-closed PIN; gate required server-side.
- **TEST:** No gate → `SECURITY_GATE_REQUIRED`.
- **RESULT:** Dual-gate Admin Security.

### PHASE 8 — Device Management
- **WHAT:** list/block/unblock/revoke/delete/force-otp/destructive bulk.
- **WHY:** Owner control of access surface.
- **SECURITY:** Invalidate then delete; confirm current device.
- **TEST:** Block → session dead + login `DEVICE_BLOCKED`.
- **RESULT:** Device ops verified.

### PHASE 9 — Audit Logs
- **WHAT:** security events; wipe without reseed; selected hard delete.
- **WHY:** Visibility without fake history.
- **SECURITY:** No secret logging.
- **TEST:** Delete single/multi; wipe total 0.
- **RESULT:** Log controls truthful.

### PHASE 10 — Frontend
- **WHAT:** Login/OTP/Security Center UX; accurate confirmations.
- **WHY:** Operability.
- **SECURITY:** No secrets; success only on backend ok.
- **TEST:** Manual UI + API parity.
- **RESULT:** Honest UI.

### PHASE 11 — Security Testing
- **WHAT:** Unit + E2E matrix (section 19).
- **WHY:** Prove enforcement.
- **SECURITY:** Direct API tests without UI.
- **TEST:** All PASS.
- **RESULT:** Evidence table.

### PHASE 12 — Production Deployment
- **WHAT:** Deploy Admin API only; upsert env; PM2 reload; wait `ready`.
- **WHY:** Real enforcement.
- **SECURITY:** No secret commits; scoped deploy.
- **TEST:** Health + `/status`.
- **RESULT:** Live commit matches GitHub.

### PHASE 13 — Final Verification
- **WHAT:** Re-run production E2E; update report + handoff.
- **WHY:** No “fixed in theory.”
- **SECURITY:** Controlled test records only.
- **TEST:** DELETE/REVOKE/BLOCK verified.
- **RESULT:** Master report + this specification.

---

## 26. REUSABLE ADMIN SECURITY IMPLEMENTATION CONTRACT

Another Admin AI **must** implement this contract:

1. **Authority:** Only the Admin backend + database decide authentication, device trust, block, revoke, delete, and session validity.
2. **Secrets:** Login PIN, Security PIN, Resend API key, JWT secret, OTP codes, and device credential plaintext never appear in frontend source, mobile binaries, GitHub, API error bodies, or logs.
3. **Login:** Email + PIN → either immediate session (trusted ACTIVE device) or OTP → device enrollment + credential + session.
4. **Trust secret:** Server-issued random device credential (hashed at rest). Fingerprint/IP/UA are binders/metadata only.
5. **Web storage:** HttpOnly + Secure (HTTPS) + SameSite cookies for session and device credential. Mobile: platform secure storage + credential header.
6. **Sessions:** Server-side session rows (`jti`) that can be revoked; block/revoke/delete must invalidate them.
7. **Security Center:** Separate Security PIN + email OTP → gate token required for device APIs (`SECURITY_GATE_REQUIRED` without it).
8. **Block:** Persist `BLOCKED`, clear credential, revoke sessions, reject `/login` with `DEVICE_BLOCKED`, reject protected APIs.
9. **Revoke:** Persist `REVOKED` (or equivalent), clear credential, revoke sessions; row may remain for audit.
10. **Delete device:** Invalidate then **hard delete** row; old credential unusable.
11. **Delete logs:** Hard DELETE selected IDs only; wipe-all must not reseed the wiped table; success requires `deleted > 0`.
12. **UI honesty:** Never show success unless backend confirms; never frontend-only delete/block.
13. **Verify:** Production E2E must prove Frontend → API → DB → session enforcement → refresh persistence before declaring done.

---

## 27. DOCUMENT CONTROL

| Field | Value |
|-------|-------|
| Spec type | Reusable master blueprint |
| Based on | Osmani Admin production system |
| Functional verification commit | `a61e7c8` |
| Integration report | `docs/ADMIN_AUTH_SECURITY_INTEGRATION_REPORT.md` |
| Secrets in this file | **None** |

End of specification.
