# APK backward compatibility (Render + VPS dual-host)

## Architecture during migration

| Client | API host | Status |
|--------|----------|--------|
| **Old production APK** (Play Store ≤ v17) | `https://osmani-admin-api.onrender.com` | Must stay on Render until DNS/APK cutover |
| **New VPS APK** | `http://144.91.117.90` (Contabo) | Same codebase + same PostgreSQL |

Both hosts share the Vultr database. Do **not** disable Render until all legacy APK users are migrated or pointed at VPS.

## Root causes (updated)

### 1. Admin auth on public GET routes (fixed in `51efc36`)
`GET /api/server-health`, `/api/settings`, `/api/popup-settings` returned 401 when `ADMIN_PANEL_AUTH_REQUIRED=true`.

### 2. Contabo `.env.cutover` leaked onto Render (fixed after `51efc36`)
`server/.env.cutover` set `STREAM_API_BASE_URL=http://144.91.117.90`. It auto-loaded on **Render** too, so channel responses from Render pointed playback at the VPS (cleartext HTTP). Legacy APK bootstrap can treat that as unreachable.

**Fix:** load `.env.cutover` only when `OSMANI_LOAD_CUTOVER_ENV=1` (Contabo PM2). Render uses dashboard `BASE_URL` + request host for streams.

### 3. `online_channels === 0` connectivity gate
When upstream probes fail, `GET /api/server-health` could return `online_channels: 0` while the API is healthy. Legacy APK shows **"Muunganisho wa Intaneti Unahitajika"** in that case.

**Fix:** public server-health floors `online_channels` to ≥1 when `total_channels > 0`, adds `ok: true` and camelCase mirrors (`onlineChannels`, etc.).

## Legacy APK endpoint matrix

### Bootstrap / connectivity
- `GET /api/health`
- `GET /api/server-health` — channel probe summary
- `GET /api/settings` — camelCase app modes (`freeMode`, `emergencyMode`, `maintenanceMode`)
- `GET /api/runtime/app-modes` — snake_case modes (v17+ OTA clients)

### Catalog
- `GET /api/channels`
- `GET /api/banners`
- `GET /api/plans`

### Runtime config
- `GET /api/settings/public` — WhatsApp + popup bundle
- `GET /api/whatsapp-settings` / `GET /api/settings/whatsapp`
- `GET /api/popup-settings` / `GET /api/settings/popup`
- `GET /api/sync/stream?topics=config` — SSE (`app_modes`, `popup_settings_changed`, etc.)

### Subscription / access
- `GET /api/subscription-status?device_id=…`
- `POST /api/subscription/verify`
- `GET /api/subscription-stream?device_id=…` — per-device SSE
- `GET /api/users-intelligence/access-check?device_id=…`
- `POST /api/users-intelligence/register`

### Payments
- `GET /api/payments/checkout-providers`
- `POST /api/payments/create-payment`
- `GET /api/payment-status/:order_id`
- `POST /api/zeno-webhook` (provider callback)

### OTA (no force migration)
- `GET /api/update-check` — `force` must remain `false` until cutover
- `GET /api/runtime/app-update`

### Playback (root mount, not under `/api`)
- `GET /stream-proxy?url=…`
- `GET /stream-direct?…`

## Verification

```bash
cd server
npm run verify:apk-backward-compat
```

Probes Render (old APK) and VPS (new APK) for all public legacy contracts.

## Cutover checklist (do not run early)

- [ ] `verify:apk-backward-compat` → 0 failures on both hosts
- [ ] Force update remains disabled (`update_force=false`)
- [ ] Render service stays **live**
- [ ] Optional: point `api.osmani.tv` CNAME to Render until APK base URL changes
- [ ] Final cutover: new APK release with VPS base URL, then retire Render
