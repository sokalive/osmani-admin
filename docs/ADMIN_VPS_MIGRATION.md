# Admin frontend migration: Render → VPS

Migrate **admin UI only** (`osmani-admin-mpya`) to Contabo. Keep **Render API** (`osmani-admin-api`) online for legacy production APK users until final APK cutover.

## Current architecture

| Service | Host | Role |
|---------|------|------|
| **osmani-admin-mpya** (Render static) | `https://osmani-admin-mpya.onrender.com` | Admin SPA (legacy deploy; bundle may reference Render API) |
| **osmani-admin-api** (Render Node) | `https://osmani-admin-api.onrender.com` | **Legacy APK API** — keep running |
| **VPS nginx + Node** | `http://144.91.117.90` | Admin SPA + API (same-origin `/api`) |

Both APIs use the same Vultr PostgreSQL database.

## Render static site (`render.yaml`)

```yaml
name: osmani-admin-mpya
runtime: static
buildCommand: npm ci && npm run build
staticPublishPath: dist
routes: /* → /index.html
```

Render builds **without** `VITE_API_BASE_URL`, so newer builds use same-origin `/api` — but the **hosted URL** is still `osmani-admin-mpya.onrender.com`, which proxies to Render’s CDN, not VPS.

## VPS admin (implemented)

`deploy/contabo/apply-cutover.sh`:

1. `VITE_API_BASE_URL=` (empty) → admin uses `https://<host>/api` via nginx
2. `npm run build` → `dist/` synced to `/var/www/osmani-admin-api/dist`
3. nginx serves SPA + proxies `/api/` → Node `:10001`

nginx config: `deploy/contabo/nginx-osmani-admin.conf`

## Domain routing (optional)

Point DNS **A record** for admin hostname to `144.91.117.90`:

| Record | Value |
|--------|--------|
| `admin.osmani.tv` | `144.91.117.90` |

nginx `server_name` includes `admin.osmani.tv`. After DNS propagates, use `http://admin.osmani.tv` (add TLS with certbot when ready).

**Do not** point `api.osmani.tv` or APK API hostnames at VPS until legacy APK cutover is complete.

## Deploy admin to VPS

```bash
cd /var/www/osmani-admin-api
git pull origin main
bash deploy/contabo/apply-cutover.sh
node deploy/contabo/verify-admin-vps.mjs
node deploy/contabo/verify-cutover.mjs
```

Or push to `main` with GitHub secret `CONTABO_SSH_KEY` (`.github/workflows/contabo-deploy.yml`).

## Verification checklist

Run from any machine:

```bash
node deploy/contabo/verify-admin-vps.mjs
```

Manual browser checks on `http://144.91.117.90` (or `admin.osmani.tv`):

- [ ] Login / admin token or email OTP
- [ ] Channels — list loads, edit saves
- [ ] Banners — list + save
- [ ] Plans — subscriber counts match Render
- [ ] Payments — ZenoPay / SonicPesa / Aurax settings load
- [ ] App Update — version fields load
- [ ] Global settings — Free / Emergency / Maintenance toggles

Legacy APK safety:

```bash
cd server && npm run verify:apk-backward-compat
```

Render API must stay **200** on all legacy endpoints.

## Disable Render admin frontend safely

**Only after** VPS admin verification passes (automated script + manual UI smoke test).

### Preconditions

- [ ] `verify-admin-vps.mjs` → `failed: 0`
- [ ] `verify-cutover.mjs` → `failed: 0`
- [ ] `verify:apk-backward-compat` → Render **0 failures** (legacy APK)
- [ ] Team uses VPS URL (`http://144.91.117.90` or `admin.osmani.tv`) for daily admin work
- [ ] DNS updated if using custom admin domain

### Steps (Render Dashboard)

1. Open [Render Dashboard](https://dashboard.render.com) → **osmani-admin-mpya** (Static Site).
2. **Do not** suspend or delete **osmani-admin-api** (Node API).
3. For **osmani-admin-mpya** only:
   - **Option A (recommended):** Settings → **Suspend** service (stops billing, reversible).
   - **Option B:** Delete static site (only if suspend is unavailable).
4. Optional: add redirect on DNS/CDN from `osmani-admin-mpya.onrender.com` to VPS admin URL (not required if team bookmarks VPS).
5. Re-run `npm run verify:apk-backward-compat` — confirm legacy APK endpoints on `osmani-admin-api.onrender.com` still pass.

### What stays on Render

| Service | Action |
|---------|--------|
| `osmani-admin-api` | **Keep live** — legacy APK |
| `osmani-admin-mpya` | Suspend after VPS verified |
| Postgres (if Render-hosted) | Unchanged — production DB is Vultr |

### Rollback

1. Resume **osmani-admin-mpya** on Render.
2. VPS admin remains available in parallel (no conflict).
