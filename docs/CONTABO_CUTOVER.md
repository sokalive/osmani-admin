# Contabo VPS cutover

Production API host: `http://144.91.117.90` (nginx :80 → Node :10001).

## Root causes (2026-06 cutover)

| Symptom | Cause |
|---------|--------|
| Admin empty when Render off | Admin SPA built with `VITE_API_BASE_URL=https://osmani-admin-api.onrender.com` |
| Thumbnails missing | `BUNNY_CDN_BASE_URL` unset on Contabo → API emits `http://144.91.117.90/uploads/...`; nginx `/uploads` served SPA HTML |
| Subscriptions “missing” | Same Vultr DB (plans/subscriber counts match Render); APK must use Contabo for **all** `/api/subscription-*` calls |
| Admin auth 503 | `ADMIN_API_TOKEN` not set on Contabo |

## Apply on VPS

```bash
cd /var/www/osmani-admin-api
git pull origin main
bash deploy/contabo/apply-cutover.sh
node deploy/contabo/verify-cutover.mjs
```

Or one-liner from Contabo console:

```bash
curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/apply-cutover.sh | OSMANI_ADMIN_ROOT=/var/www/osmani-admin-api bash
```

### What apply-cutover fixes

- Loads `server/.env` + `server/.env.cutover` via `start-with-env.sh` (PM2 `env_file` is unreliable)
- Sets `BUNNY_CDN_BASE_URL`, `ADMIN_API_TOKEN`, `BASE_URL` in `.env` if missing
- Nginx: `^~ /uploads/` → Bunny CDN; `^~ /api/` → Node :10001; removes `default` site
- Rebuilds admin SPA with same-origin `/api`

### Auto-deploy (optional)

Add GitHub secret `CONTABO_SSH_KEY` (root private key). Push to `main` runs `.github/workflows/contabo-deploy.yml`.

## Verify

```bash
node deploy/contabo/verify-cutover.mjs
node deploy/contabo/verify-admin-vps.mjs
curl -s http://144.91.117.90/api/runtime/cutover-status | jq
```

Admin UI: `http://144.91.117.90` (same-origin `/api`). See [ADMIN_VPS_MIGRATION.md](./ADMIN_VPS_MIGRATION.md) to retire Render static admin.
