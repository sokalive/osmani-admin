# APK backward compatibility (Render + VPS dual-host)

## Architecture during migration

| Client | API host | Status |
|--------|----------|--------|
| **Old production APK** (Play Store ≤ v17) | `https://osmani-admin-api.onrender.com` | Must stay on Render until DNS/APK cutover |
| **New VPS APK** | `http://144.91.117.90` (Contabo) | Same codebase + same PostgreSQL |

Both hosts share the Vultr database. Do **not** disable Render until all legacy APK users are migrated or pointed at VPS.

## Root cause: "No Internet Connection" on old APK

Production has `ADMIN_PANEL_AUTH_REQUIRED=true`. Three **legacy public GET** routes were incorrectly gated behind admin session auth:

| Endpoint | Was | Impact on old APK |
|----------|-----|-------------------|
| `GET /api/server-health` | 401 | Connectivity probe fails → "No Internet Connection" |
| `GET /api/popup-settings` | 401 | Bootstrap config fetch fails |
| `GET /api/settings` | 401 | App modes (`freeMode` / `maintenanceMode`) unavailable |

**Fix:** restore public read on these routes; admin PUT/write paths remain protected.

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
