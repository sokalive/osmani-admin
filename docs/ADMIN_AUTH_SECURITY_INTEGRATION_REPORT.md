# Osmani Admin — Authentication & Device Security Integration Report

Date: 2026-09-10  
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
| POST | `/devices/:id/revoke` | session + gate + pin | — | `{ ok }` | soft revoke |
| DELETE | `/devices/:id` | session + gate + pin | — | `{ ok }` | soft revoke |

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
| Live OTP/device block on production | after deploy + env upsert | pending deploy verification | PENDING |

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
- Branch: `main`
- Push status: pushed to `origin/main`
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
- Live commit: `78dc9a74a6be779292f4bdc7e3bbf2772ba3fd59`
- `panelAuthRequired: true`
- Auth secrets present in `server/.env` (values not logged)
- Tables/columns verified; block/revoke E2E passed

### Readiness hang root cause
Health on `http://127.0.0.1:10001/api/health` was already OK. The stuck verifier hung later on full `ensureBillingTables()` / extra PG pool usage, not on an infinite health poll. Bounded verification replaced that path.

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
   - else → Login
2. Login → `POST /api/admin/auth/login` with `{ email, pin, device_fingerprint, device_name, browser }`
   - `step: authenticated` → save token, home
   - `step: otp_required` → OTP screen with `pendingToken`
3. OTP → `POST /api/admin/auth/verify-otp`
   - save `deviceCredential` + `token`
   - if `isNewDevice`, optional UI notice (server also emails admin)
4. Any API `403` with `DEVICE_BLOCKED` / `DEVICE_REVOKED` or `401 SESSION_REVOKED` → wipe and re-login
5. Logout → `POST /api/admin/auth/logout` then wipe local credential + token

### Admin Security (if App exposes it)
- Requires existing session.
- `POST .../admin-security/verify-pin` with `security_pin` (user-entered; never hardcode).
- Then OTP to `ADMIN_ALERT_EMAIL`, then `gateToken` as `X-Admin-Security-Gate` for device list/block/revoke.

### Absolute prohibitions
- No hardcoded login PIN / security PIN / Resend key.
- No local `loggedIn=true` as proof of auth.
- No trusting fingerprint/IP/UA alone.
- No logging credentials.

### Config the App needs (non-secret)
- API base URL for Osmani Admin backend.
- Knowledge that panel auth is required (`panelAuthRequired: true` from `/status`).
- OTP is 6 digits, short TTL, single-use; respect `429` lockouts.

