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
cd /var/www/osmani-admin
git pull origin main
bash deploy/contabo/apply-cutover.sh
```

Edit `server/.env` from `deploy/contabo/env.production.example` first (DATABASE_URL, ADMIN_API_TOKEN, BUNNY_CDN_BASE_URL).

## Verify

```bash
node deploy/contabo/verify-cutover.mjs
curl -s http://144.91.117.90/api/runtime/cutover-status | jq
```
