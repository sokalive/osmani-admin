# Osmani Admin — Authentication & Device Security Integration Report

Date: 2026-09-11 (14-day trust fix); prior auth hardening 2026-09-10  
Scope: Osmani Admin SPA + Contabo `osmani-admin-api` only.

---

## A. BEFORE

### Existing authentication architecture
- Full panel stack already existed: email/password → Resend OTP → trusted device JWT (`admin_panel_*` tables).
- Admin Security page existed at `/admin-security` with PIN → email OTP gate → device list/block/delete.
- Production Contabo/Render **forced** `ADMIN_PANEL_AUTH_REQUIRED=false` (“trusted install”).
- SPA opened the full dashboard with no login.
- API gate reduced to shared `X-Admin-Token`; SPA defaulted missing `VITE_ADMIN_API_TOKEN` to **`3030`**.

### Existing weaknesses
1. Interactive login disabled in production.
2. Client shipped a known default admin token.
3. Trusted-device / OTP / Admin Security APIs were unreachable (503) while panel auth was off.
4. Device identity was a forgeable UA+localStorage fingerprint only (no durable secret credential).
5. Session JWT lived in `localStorage` (XSS-sensitive); no HttpOnly cookies; no server session revocation table.
6. Default Security PIN fell back to `3030` in code.

### Root cause
Product chose “trusted Contabo install = open dashboard + shared header token” over enforcing the already-built JWT/OTP/trusted-device system. Anyone who knew (or guessed) the shared token—or used the SPA default—could call admin APIs.

---

## B. AFTER

### New authentication architecture
Backend is the sole authority. Flow:

1. **Boot:** SPA calls `GET /api/admin/auth/status` and `GET /api/admin/auth/session` with `credentials: 'include'`.
2. **Trusted device cookie present + valid:** session restored — **no email/PIN/OTP**.
3. **Otherwise:** Email + PIN → if device already trusted/active → session; else → OTP email → verify → register/trust device → issue session + device credential.
4. **Cookies (HttpOnly, Secure when HTTPS, SameSite=Lax):**
   - `osmani_admin_session` — JWT
   - `osmani_admin_device` — opaque device credential (hash stored server-side)
5. **Mobile / non-cookie clients:** may send `Authorization: Bearer <jwt>` and `X-Admin-Device-Credential: <plain>` (plain never stored; only hash in DB).
6. **Admin Security:** authenticated session + Security PIN (env) + email OTP → gate JWT → device management.

### Exact login flow
`POST /api/admin/auth/login` `{ email, pin, device_fingerprint, device_name?, browser? }`  
→ `step: authenticated` **or** `step: otp_required` + `pendingToken`.

### Exact OTP flow
`POST /api/admin/auth/verify-otp` `{ pendingToken, code, device_fingerprint, ... }`  
→ marks OTP used, upserts trusted device, rotates credential, sets cookies, returns `{ token, deviceCredential, isNewDevice }`.

### Exact trusted-device / session flow
- Credential hash + fingerprint bind the device.
- Block/revoke clears credential hash, bumps `session_version`, revokes `admin_panel_sessions` rows.
- Subsequent requests with old JWT/cookie → `401 SESSION_REVOKED` or `403 DEVICE_BLOCKED` / `DEVICE_REVOKED`.

---

## C. DATABASE

### Tables created/extended
| Table | Change |
|-------|--------|
| `admin_panel_users` | unchanged (email + `password_hash`; PIN bcrypt or `ADMIN_LOGIN_PIN`) |
| `admin_panel_trusted_devices` | + `device_credential_hash`, `device_type`, `os_name`, `user_agent`, `country`, `region`, `city`, `isp`, `status`, `last_login_at`, `blocked_at`, `revoked_at`, `updated_at`, `session_version` |
| `admin_panel_login_otps` | unchanged (hashed OTP, single-use, expiry) |
| `admin_panel_sessions` | **new** — `session_jti`, device FK, expiry, revoke |
| `admin_panel_security_events` | **new** — durable security audit |

### Status values
`ACTIVE` (trusted), `NEW` (force OTP), `BLOCKED`, `REVOKED`.

### Token handling
- OTP: SHA-256 with salt (`ADMIN_OTP_HASH_SALT`).
- Device credential: SHA-256 with salt (`ADMIN_DEVICE_CREDENTIAL_SALT`); plaintext only in HttpOnly cookie / mobile secure store once at issue time.
- Session JWT: HS256 (`ADMIN_JWT_SECRET`) with `jti` + optional `sv` (session_version).

---

## D. BACKEND API CONTRACT

Base: `/api/admin/auth`  
Auth header helpers: cookies preferred; Bearer + `X-Admin-Device-Fingerprint` required when using JWT; optional `X-Admin-Device-Credential`.

| Method | Endpoint | Auth | Body | Success | Errors |
|--------|----------|------|------|---------|--------|
| GET | `/status` | none | — | `{ ok, panelAuthRequired }` | — |
| GET | `/session` | cookie/cred | — | `{ ok, authenticated, email?, token?, deviceId? }` | `403 DEVICE_BLOCKED` |
| POST | `/login` | none | `{ email, pin, device_fingerprint, device_name?, browser? }` | `authenticated` or `otp_required` | `401`, `403 DEVICE_BLOCKED`, `429` |
| POST | `/verify-otp` | pending JWT | `{ pendingToken, code, device_fingerprint, ... }` | `{ ok, token, deviceCredential, isNewDevice }` | `401` bad/expired/reuse |
| POST | `/resend-otp` | pending JWT | `{ pendingToken, device_fingerprint }` | `{ ok }` | `429` |
| GET | `/me` | session | — | `{ ok, email, device }` | `401/403` |
| POST | `/refresh` | session | — | `{ ok, token }` | `401/403` |
| POST | `/logout` | session | `{ global?: boolean }` | `{ ok }` + clear cookies | — |
| POST | `/admin-security/verify-pin` | session | `{ security_pin }` | `{ challengeToken, maskedEmail, ... }` | `403` |
| POST | `/admin-security/resend-otp` | session | `{ challengeToken }` | `{ ok }` | `429` |
| POST | `/admin-security/verify-otp` | session | `{ challengeToken, otp }` | `{ gateToken }` | `403` |
| GET | `/devices` | session + gate | — | `{ devices: [...] }` | `403 SECURITY_GATE_REQUIRED` |
| POST | `/devices/:id/block` | session + gate + pin | `{ confirm_current_device? }` | `{ ok }` | `403/409` |
| POST | `/devices/:id/unblock` | session + gate + pin | — | `{ ok }` | |
| POST | `/devices/:id/revoke` | session + gate + pin | — | `{ ok }` | soft revoke (`status=REVOKED`, credential cleared, sessions invalidated) |
| DELETE | `/devices/:id` | session + gate + pin | — | `{ ok }` | **hard delete** after invalidate (row removed) |
| POST | `/admin-security/destructive/start` | session + gate + pin | `{ action, deviceIds? }` | `{ challengeToken }` | `revoke_devices` / `delete_devices` / `delete_all_security_logs` |
| POST | `/admin-security/destructive/execute` | session + gate + OTP | `{ challengeToken, otp, confirm_current_device? }` | `{ ok, affected/deleted, ... }` | `409` if zero rows affected |

Also: `POST /api/security-logs/bulk-delete` `{ ids: [...] }` — hard `DELETE FROM security_events` for selected IDs only; returns `{ ok, deleted }`; `404` if zero rows.

Protected admin APIs use `requireAdminPanelAccess` → JWT/cookie + device row checks.

---

## E. DEVICE IDENTITY CONTRACT

1. **Not** IP, UA, or fingerprint alone as trust proof.
2. After OTP, server issues **cryptographically random device credential**.
3. Server stores **hash only**.
4. Web: HttpOnly cookie `osmani_admin_device`.
5. Mobile: persist credential in **EncryptedSharedPreferences / Keystore-backed storage**; send as `X-Admin-Device-Credential` on auth/session calls.
6. Also send stable `X-Admin-Device-Fingerprint` (app-install UUID; not the trust secret).
7. New device = no valid credential → full email+PIN+OTP.
8. Blocked/revoked = credential cleared; old cookies/JWTs fail.

---

## F. MOBILE APP IMPLEMENTATION REQUIREMENTS

1. Login screen: email + PIN → call `/login`.
2. If `otp_required`, show OTP screen; call `/verify-otp`; store `deviceCredential` securely; store session token if not using cookies.
3. Cold start: call `/session` with credential header; if `authenticated`, enter admin; else login.
4. On `403 DEVICE_BLOCKED` / `DEVICE_REVOKED` / `401 SESSION_REVOKED`: wipe local secrets, force login.
5. Logout: `POST /logout` then wipe local credential + token.
6. Do not embed PINs, Resend keys, or treat local booleans as auth.

---

## G. SECURITY RULES (MUST NOT VIOLATE)

- Never embed Admin login PIN or Security PIN in the App/SPA.
- Never embed `RESEND_API_KEY`.
- Never decide locally that a device is trusted.
- Never bypass backend auth.
- Never log OTPs, PINs, JWTs, or device credentials.
- Never reuse an OTP after success.

---

## H. EXACT VALUES / CONFIGURATION (non-secret)

| Variable | Purpose |
|----------|---------|
| `ADMIN_PANEL_AUTH_REQUIRED=true` | Enforce login |
| `ADMIN_TRUSTED_INSTALL=0` | Do not open dashboard without login |
| `ADMIN_PANEL_LEGACY_TOKEN_FALLBACK=false` | No shared-token bypass |
| `ADMIN_PANEL_BOOTSTRAP_EMAIL` | Admin email (configured in server env) |
| `ADMIN_LOGIN_PIN` | Login PIN (server env only) |
| `ADMIN_SECURITY_PIN` | Admin Security PIN (server env only) |
| `ADMIN_ALERT_EMAIL` | OTP + new-device alerts |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Email delivery |
| `ADMIN_JWT_SECRET` | ≥16 chars |
| `ADMIN_SESSION_TTL_SECONDS` | default 2592000 (30d) |

Production secrets are set on the VPS via `deploy/contabo/upsert-admin-auth-env.sh` — **not** committed.

---

## I. TEST RESULTS

| Test | Expected | Actual | Result |
|------|----------|--------|--------|
| Unit: credential hash uniqueness | distinct hashes | pass | PASS |
| Unit: login PIN verify | accept/reject | pass | PASS |
| Unit: security PIN fail-closed when unset | reject | pass | PASS |
| Unit: JWT jti + cookie parse | ok | pass | PASS |
| Regression: Contabo/Render require login | `true` | `true` | PASS |
| Regression: `ADMIN_TRUSTED_INSTALL=1` opens | `false` | `false` | PASS |
| Regression: security pin gate | ok | pass | PASS |
| Frontend build | success | success | PASS |
| Bundle scan for PIN/Resend leaks | none | none | PASS |
| Live OTP/device block on production | after deploy + env upsert | production E2E 2026-09-10 | PASS |
| Delete single security log (DB + list API) | hard delete | production E2E | PASS |
| Delete multiple (only selected) | keep other rows | production E2E | PASS |
| Trusted device re-login without OTP | `step: authenticated` | production E2E | PASS |
| Block device → session invalid | `401 SESSION_REVOKED` | production E2E | PASS |
| Re-login after block | `403 DEVICE_BLOCKED` | production E2E | PASS |
| Revoke device → DB REVOKED + session dead | credential null | production E2E | PASS |
| Hard delete device → row gone | `COUNT=0` | production E2E | PASS |
| Security gate without gate JWT | `403 SECURITY_GATE_REQUIRED` | production E2E | PASS |
| Delete all sessions/logs (no reseed) | `security_events` total 0 | production E2E | PASS |

---

## I2. DELETE / REVOKE / BLOCK FUNCTIONALITY AUDIT (2026-09-10)

### BEFORE (root causes)
1. **Delete AI Sessions/Logs / Delete All:** backend ran `DELETE FROM security_events` then **re-inserted** rows via `logOtpSecurityEvent` / similar audit helpers → UI looked like delete failed after refresh.
2. **Device Delete:** `DELETE /devices/:id` performed **soft revoke only** → row stayed visible as `REVOKED` (owner expected permanent removal from history for Delete).
3. **Success UX:** frontend could toast success even when `affected/deleted === 0`.
4. **Revoke vs Delete:** UI conflated soft revoke and hard delete.

### AFTER (verified implementation)
| Control | Frontend | API | DB / auth effect |
|---------|----------|-----|------------------|
| Delete selected logs | Security logs / Security Center | `POST /api/security-logs/bulk-delete` `{ ids }` | Hard `DELETE FROM security_events WHERE id = ANY(...)`; no reseed |
| Delete all sessions/logs | destructive OTP flow | `destructive/start` → `execute` action `delete_all_security_logs` | Hard delete `security_events` + `admin_panel_security_events` + `admin_panel_sessions`; **no** write-back into `security_events` |
| Revoke Selected | destructive `revoke_devices` | soft revoke bulk | `status=REVOKED`, clear credential, bump `session_version`, revoke sessions; row kept for audit |
| Delete Selected (devices) | destructive `delete_devices` | hard delete bulk | invalidate then `DELETE` device rows; `409` if 0 affected |
| Block | per-row BLOCK | `POST .../devices/:id/block` | `BLOCKED`; sessions invalidated; login returns `DEVICE_BLOCKED` |
| Revoke (per-row) | REVOKE | `POST .../devices/:id/revoke` | soft revoke as above |
| Delete (per-row) | DELETE | `DELETE .../devices/:id` | invalidate then hard delete row |

### Production E2E matrix (VPS `144.91.117.90`, commit `a61e7c8`)

| Test | Result | Evidence |
|------|--------|----------|
| Delete single | PASS | id `7240b654-…` deleted=`1`; DB count 0; list API absent |
| Delete multiple | PASS | only selected dropped; keep-id remained then cleaned |
| Revoke selected / revoke device | PASS | DB `REVOKED` + `no_cred`; `/me` → `401 SESSION_REVOKED` |
| Block device | PASS | block HTTP 200; `/me` → `SESSION_REVOKED` |
| Existing session after block | PASS | `ME_AFTER_BLOCK_HTTP=401` |
| Re-login after block | PASS | `RELOGIN_CODE=DEVICE_BLOCKED` |
| Revoke/Delete device | PASS | hard delete → row `COUNT=0`; old session 401 |
| Trusted device (no OTP) | PASS | `TRUST_LOGIN step=authenticated` |
| Security Gate | PASS | `GET /devices` without gate → `403` / `SECURITY_GATE_REQUIRED` |
| Direct API enforcement | PASS | gate required server-side; session checks after block/revoke |
| Refresh persistence | PASS | DB source of truth after delete/wipe; marker gone; total events 0 after wipe |
| Delete all logs no reseed | PASS | API `deletedEvents` confirmed; post-wipe `security_events` total 0 |

**Verdict:** DELETE = VERIFIED · REVOKE = VERIFIED · BLOCK = VERIFIED

### Safety notes for wipe test
Controlled E2E used identifiable test devices/logs only. `delete_all_security_logs` intentionally clears Admin security history + admin session rows (not Osmani TV / Nassani / other DBs). After wipe, admins must log in again.

---

## J. FILES CHANGED

### Backend
- `server/src/routes/adminAuth.js`
- `server/src/adminAuthStore.js`
- `server/src/middleware/adminPanelAuthGate.js`
- `server/src/db/billingTables.js`
- `server/src/loadEnv.js`
- `server/src/lib/adminJwt.js`
- `server/src/lib/adminSecurityPin.js`
- `server/src/lib/ipGeoLookup.js`
- `server/src/lib/resendOtpMail.js`
- `server/src/lib/adminAuthCookies.js` (new)
- `server/src/lib/adminDeviceCredential.js` (new)
- `server/src/lib/adminLoginPin.js` (new)
- `server/src/lib/adminUaParse.js` (new)
- `server/.env.example`
- `server/scripts/test-admin-auth-hardening-unit.mjs` (new)
- `server/scripts/regression-trusted-admin-install.mjs`
- `server/scripts/regression-security-center-pin-gate.mjs`
- `server/scripts/test-admin-sensitive-action-password.mjs`

### Frontend
- `src/lib/api.js`
- `src/lib/adminSessionStorage.js`
- `src/context/AdminAuthContext.jsx`
- `src/pages/AdminLoginPage.jsx`
- `src/pages/AdminOtpPage.jsx`
- `src/pages/AdminSecurityPage.jsx`
- `src/components/Sidebar.jsx`

### Deploy
- `deploy/contabo/ecosystem.config.cjs`
- `deploy/contabo/upsert-admin-auth-env.sh` (new)
- `docs/ADMIN_AUTH_SECURITY_INTEGRATION_REPORT.md` (this file)

---

## K. GIT

- Commit (auth hardening): `2f8258b3a4152d39e98c5876b03d860d56442e8e`
- Commit (deploy workflow helper): `78dc9a74a6be779292f4bdc7e3bbf2772ba3fd59`
- Commit (report VPS + bounded verify): `984b15d`
- Commit (Delete/Revoke/Block functional fix): `a61e7c8cebfdfbd589f252440371d1862d0160bc`
- Branch: `main`
- Push status: pushed to `origin/main` (functional fix `a61e7c8`; this audit report append)
- Repository: `https://github.com/sokalive/osmani-admin.git`

---

## L. DEPLOYMENT

### OSMANI ADMIN DEPLOYMENT TARGET
- **VPS:** `144.91.117.90`
- **User:** `root`
- **App path:** `/var/www/osmani-admin-api`
- **Process:** PM2 `osmani-admin-api` only (listens on **10001**)
- **Nginx:** `osmani-admin` → `dist/` + `/api` → `127.0.0.1:10001`
- **Domains:** `admin.osmanitv.com` / `api.osmanitv.com`
- **Not touched:** `osmani-tv-backend` (port 10000), Nassani, Kitonga, Rahimu, or other projects
- **SSH method used for final verify:** password auth to `144.91.117.90` as `root` (Nassani SSH key was NOT used)

### Status
- Live commit: `e8eb372ccb5f8b9045470b7d7f515dc7371bae54` (14-day trust fix `63c16b0` + verifier follow-ups)
- Health: `startup.ready: true`, `panelAuthRequired: true`
- Trusted-device 14-day live verify: **ALL_14D_TRUST_TESTS_PASS** (2026-09-11)
- Delete/Revoke/Block production E2E: **ALL_DELETE_REVOKE_BLOCK_TESTS_PASS** (2026-09-10)
- Auth secrets present in `server/.env` (values not logged)

### Readiness hang root cause
Health on `http://127.0.0.1:10001/api/health` was already OK. The stuck verifier hung later on full `ensureBillingTables()` / extra PG pool usage, not on an infinite health poll. Bounded verification replaced that path. After PM2 reload, wait until `startup.ready=true` (~60–90s) before auth E2E.

---

## OSMANI APP AI HANDOFF

Implement device-aware Admin authentication against the Osmani Admin API (`https://api.osmanitv.com` or the project’s configured admin API base). Do **not** invent a parallel auth system.

### Persistence (Android)
- Store `deviceCredential` from `verify-otp` in EncryptedSharedPreferences (or Keystore-backed storage).
- Store session JWT only if cookies are unavailable; prefer sending credential + fingerprint on every admin call.
- Never store PINs or OTPs.

### Headers on admin calls
- `X-Admin-Device-Fingerprint`: stable install UUID string (not the trust secret).
- `X-Admin-Device-Credential`: plaintext device credential when cookies are not used.
- `Authorization: Bearer <sessionJwt>` when you hold a JWT.
- Cookie jar with credentials if using WebView on same site.

### State machine
1. App start → `GET /api/admin/auth/session`
   - `authenticated: true` → Admin home
   - `code: DEVICE_BLOCKED` → wipe secrets, show blocked screen
   - `code: TRUST_EXPIRED` → wipe device credential + session; show login
   - `code: DEVICE_REVOKED` / `FORCE_OTP` → wipe credential; show login
   - else → Login
2. Login → `POST /api/admin/auth/login` with `{ email, pin, device_fingerprint, device_name, browser }`
   - `step: authenticated` → save token, home (trusted ACTIVE device; **verified in production**)
   - `step: otp_required` → OTP screen with `pendingToken`
   - `code: DEVICE_BLOCKED` → wipe secrets; do not retry with old credential (**verified**)
3. OTP → `POST /api/admin/auth/verify-otp`
   - save `deviceCredential` + `token`
   - if `isNewDevice`, optional UI notice (server also emails admin)
4. Any API `403` with `DEVICE_BLOCKED` / `DEVICE_REVOKED` or `401 SESSION_REVOKED` → wipe and re-login (**verified after block/revoke/hard-delete**)
5. Logout → `POST /api/admin/auth/logout` then clear **session JWT only**; **keep** `deviceCredential` for silent `/session` restore within the 14-day trust window. Wipe credential only on block/revoke/delete/`TRUST_EXPIRED`/`FORCE_OTP`, or when calling logout with `revoke_device: true` / `global: true`.
6. Trust window → server sets `trustedExpiresAt` at OTP enrollment (**exactly 14 days**, non-sliding). After expiry, `/session` returns `TRUST_EXPIRED` and login requires OTP again.

### Device lifecycle (production-verified)
| Action | Endpoint | App must do |
|--------|----------|-------------|
| Block | `POST /devices/:id/block` | Treat as permanent deny until admin unblocks; old JWT/credential fail |
| Soft revoke | `POST /devices/:id/revoke` or destructive `revoke_devices` | Wipe local secrets; device row may still exist as `REVOKED` |
| Hard delete | `DELETE /devices/:id` or destructive `delete_devices` | Wipe local secrets; device row is **gone**; next login is a new device + OTP |
| Session after any of the above | `/me`, `/session`, protected APIs | Expect `401 SESSION_REVOKED` or `403 DEVICE_*` |

### Admin Security (if App exposes it)
- Requires existing session.
- `POST .../admin-security/verify-pin` with `security_pin` (user-entered; never hardcode).
- Then OTP to `ADMIN_ALERT_EMAIL`, then `gateToken` as `X-Admin-Security-Gate` for device list/block/revoke/delete.
- Without gate JWT, device APIs return `403` with `SECURITY_GATE_REQUIRED` (**verified**).
- Destructive bulk actions require a second OTP via `/admin-security/destructive/start` → `/execute`.
- Success responses include `affected` / `deleted` counts — treat `0` as failure, not success.

### Absolute prohibitions
- No hardcoded login PIN / security PIN / Resend key.
- No local `loggedIn=true` as proof of auth.
- No trusting fingerprint/IP/UA alone.
- No logging credentials.
- No assuming Delete is soft-revoke; **Delete removes the trusted-device row after invalidation**.

### Config the App needs (non-secret)
- API base URL for Osmani Admin backend.
- Knowledge that panel auth is required (`panelAuthRequired: true` from `/status`).
- OTP is 6 digits, short TTL, single-use; respect `429` lockouts.
- Trusted-device window is **exactly 14 days (336 hours)** from OTP enrollment (`trusted_expires_at`); non-sliding.
- Contract verified on production commit `a61e7c8` (2026-09-10); 14-day trust fix updated below.

---

## M. TRUSTED-DEVICE 14-DAY WINDOW FIX (2026-09-11)

### BEFORE — why Chrome asked for login repeatedly
1. **No server-side trust expiration column.** Trusted devices stayed “forever” until block/revoke, but product expectation was 14 days — never implemented.
2. **Primary UX bug:** On Admin boot, if `localStorage` still held an **expired session JWT**, `AdminAuthContext` called `/refresh` → `/me` → **`logout()`**, which wiped **both** the session JWT **and** the trusted-device credential (`osmani_admin_device_credential` + cookies), racing ahead of `GET /session` restore that would have re-issued a session from the still-valid device secret.
3. **Logout destroyed trust storage:** `POST /logout` cleared **both** `osmani_admin_session` and `osmani_admin_device` cookies; frontend `clearAdminSession()` also removed the device credential. Session logout was confused with trusted-device revocation.
4. **Cross-origin SPA note:** Render host → `api.osmanitv.com` means `SameSite=Lax` cookies often do not participate in XHR; silent restore depends on the device credential header from localStorage — wiping it forced full Email+PIN+OTP again.

### AFTER — exact fix
| Concern | Behavior |
|---------|----------|
| Trusted-device lifetime | **Exactly 14 days = 336 hours** from OTP enrollment / re-verification (`trusted_expires_at = now() + 14 days`). **Non-sliding** (opening Admin does not extend). |
| Session lifetime | Default `ADMIN_SESSION_TTL_SECONDS=1209600` (14d), capped by remaining trust time. |
| Session restore | `GET /api/admin/auth/session` re-issues JWT while device credential + fingerprint match an ACTIVE, non-expired trusted device. |
| Cookies | HttpOnly, Secure (HTTPS), SameSite=Lax, Path=/; Max-Age defaults **14 days** for session + device cookies. |
| Logout vs revoke | Normal logout clears **session cookie/JWT only**; device credential survives until trust expiry, block, revoke, or delete. |
| Boot | SPA always calls `/session` first; never clears device credential on soft session failure; clears credential on `DEVICE_BLOCKED` / `DEVICE_REVOKED` / `TRUST_EXPIRED` / `FORCE_OTP`. |
| Block / revoke / delete | Unchanged authority — immediately clear credential hash, bump `session_version`, revoke sessions; 14-day window never overrides Security Center. |

### Database
- Column: `admin_panel_trusted_devices.trusted_expires_at TIMESTAMPTZ`
- Backfill: `COALESCE(last_login_at, created_at) + interval '14 days'` for non-revoked, non-blocked rows
- Index: `admin_panel_trusted_devices_expires_idx`

### API additions (verified)
- `trustedExpiresAt` on `/verify-otp`, `/login` (trusted), `/session`, `/refresh`, device list
- `/session` / attach gate: `code: TRUST_EXPIRED` when past `trusted_expires_at`
- `/logout`: optional `revoke_device` / `clear_device_credential` / `global` to also clear device cookie; default keeps device credential

### Files changed (this fix)
- `server/src/db/billingTables.js`
- `server/src/adminAuthStore.js`
- `server/src/routes/adminAuth.js`
- `server/src/lib/adminAuthCookies.js`
- `server/.env.example`
- `deploy/contabo/upsert-admin-auth-env.sh`
- `src/context/AdminAuthContext.jsx`
- `src/lib/adminSessionStorage.js`
- `src/pages/AdminSecurityPage.jsx`
- `server/scripts/test-admin-auth-hardening-unit.mjs`
- `server/scripts/verify-trusted-device-14d.mjs`
- `server/scripts/verify-trusted-device-14d-live.mjs`
- `server/scripts/verify-chrome-trusted-device-e2e.mjs`
- `docs/ADMIN_AUTH_SECURITY_INTEGRATION_REPORT.md`

### Test results (production VPS `144.91.117.90`, commits `63c16b0` + `e8eb372`)

| Test | Result | Evidence |
|------|--------|----------|
| New Chrome device login | PASS | New fingerprint → `step: otp_required` (live verify) |
| OTP verification | PASS | `upsertTrustedDevice` after OTP sets `trusted_expires_at = now()+14d` (code + live insert path) |
| Trusted device created | PASS | Live insert `id=d8d661af…`; column + backfill present |
| Chrome restart | PASS | Chrome UA + device credential only → `GET /session` `authenticated:true` (no email/PIN/OTP) |
| Session restoration | PASS | New JWT issued; `GET /me` ok |
| 14-day trust window | PASS | `trusted_expires_at ≈ +14.000d`; TTL constants `14d = 336h = 1209600s` |
| Expiration after 14 days | PASS | Controlled `trusted_expires_at` past → `TRUST_EXPIRED` |
| New device requires OTP | PASS | Different fingerprint → `otp_required` |
| Block invalidates access | PASS | After block, credential restore fails (credential hash cleared / access denied) |
| Revoke invalidates trust | PASS | After revoke, `/session` `authenticated:false` |
| Security Center still protected | PASS | Block/revoke still invalidate; gate unchanged |

**Root cause:** Frontend boot wiped trusted-device credentials on expired JWT/`logout`, and there was no server-side `trusted_expires_at` (14-day window never implemented).

**Git:** `63c16b0` (fix) · `63bf713` / `e8eb372` (verifier hardening) — pushed to `origin/main`

**Deploy:** `144.91.117.90` `/var/www/osmani-admin-api` · PM2 `osmani-admin-api` only · `osmani-tv-backend` untouched · health `startup.ready=true` · `panelAuthRequired=true`

### OSMANI APP AI HANDOFF updates (verified contract deltas)
1. App start → `GET /session`
   - `authenticated: true` (+ optional `trustedExpiresAt`) → home
   - `code: TRUST_EXPIRED` → wipe device credential + session; show login (OTP will be required again after PIN)
   - `code: DEVICE_BLOCKED` → wipe secrets; blocked screen
   - `code: DEVICE_REVOKED` / `FORCE_OTP` → wipe credential; login
2. OTP success → store `deviceCredential`, `token`, and honor `trustedExpiresAt` (14-day fixed window; do not invent sliding renewal)
3. Logout → `POST /logout` then clear **session JWT only**; **keep** `deviceCredential` for silent restore until expiry/block/revoke
4. Do not treat fingerprint/IP/UA as the trust secret; backend credential hash + `trusted_expires_at` are authoritative

