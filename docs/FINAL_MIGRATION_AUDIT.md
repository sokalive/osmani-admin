# Final migration audit — Osmani TV

Run: `node deploy/contabo/verify-final-migration-audit.mjs`

## Architecture (2026-06)

| Service | URL | Role | Keep ON? |
|---------|-----|------|----------|
| **osmani-admin-api** | `https://osmani-admin-api.onrender.com` | Legacy APK API | **YES** until APK cutover |
| **osmani-admin-mpya** | `https://osmani-admin-mpya.onrender.com` | Render admin SPA | Optional after VPS admin verified |
| **osmani-tv** | `https://osmani-tv.onrender.com` | Placeholder (28B) | Safe to suspend |
| **VPS API + Admin** | `http://144.91.117.90` | New APK + admin UI | **YES** |
| **Vultr PostgreSQL** | `155.138.223.205` / `osmani_db` | Shared DB | **YES** |

## Vultr DB parity evidence

Both Render API and VPS API read the same database:

- Host: `155.138.223.205:5432` / `osmani_db`
- Active device subscriptions: **202** (both hosts)
- Plan subscriber counts: `3:122, 4:64, 5:0, 6:1` (identical)
- Channels: **17** (names match)
- Banners: **3**
- `device_id` probe returns same `active` on both hosts (shared state)

## Old APK (Render API) — verified

All legacy public endpoints pass on Render (`verify:apk-backward-compat` → **0 failures**):

- channels, banners, plans, subscription-status, payments, update-check (force off)
- server-health, settings, popup-settings (public read restored)
- Stream delivery URLs use `osmani-admin-api.onrender.com` (not VPS)

## New APK (VPS) — action required

VPS must run latest `main` (`apply-cutover.sh`) for legacy public routes:

- `GET /api/server-health`, `/api/settings`, `/api/popup-settings` → currently **403** on stale VPS build
- After deploy: same contracts as Render

```bash
cd /var/www/osmani-admin-api
git pull origin main
bash deploy/contabo/apply-cutover.sh
node deploy/contabo/verify-final-migration-audit.mjs
```

## Device migration (old APK → new APK)

Same `device_id` + shared Vultr DB → subscription state preserved:

- `device_subscriptions`, `transactions`, plan, expiry, payment history all in Postgres
- No separate Render-only subscriber store
- New APK pointing at VPS reads the same rows as old APK on Render

## Safe to suspend (after VPS admin verified)

- `osmani-admin-mpya` (Render static admin)
- `osmani-tv` (placeholder only)
- `osmani-tv-web.onrender.com` (404 / unused)

## Do NOT suspend

- **osmani-admin-api** (Render Node) — legacy production APK
- Vultr PostgreSQL
- VPS nginx + Node + admin SPA

## Contabo independence

VPS can operate without Render **static admin** or **osmani-tv**:

- Admin UI: `http://144.91.117.90` (same-origin `/api`)
- API, DB, CDN thumbnails, subscriptions: all on VPS path
- Legacy APK still needs Render **API** until app update cutover
