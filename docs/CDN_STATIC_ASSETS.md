# Static assets + APK delivery on Bunny CDN

Uploaded files stay on disk under `UPLOAD_DIR` and in the database as `/uploads/...` paths or legacy Render absolute URLs. **API responses** expose absolute **Bunny** URLs when `BUNNY_CDN_BASE_URL` is set.

## Configure Bunny

1. Create a **Pull Zone** in Bunny.net pointing at your API origin, e.g. `https://osmani-admin-api.onrender.com`.
2. Enable caching for `GET` on `/uploads/*` (images and APKs).
3. Set on the **API** service (Render → Environment):

   ```bash
   BUNNY_CDN_BASE_URL=https://your-zone.b-cdn.net
   BASE_URL=https://osmani-admin-api.onrender.com
   ```

4. Redeploy the API. Logs should show: `[cdn] Bunny enabled → https://...`

## What moves to CDN

| Asset | API fields | Stored path |
|-------|------------|-------------|
| Channel thumbnails | `thumbnail`, `thumbnailUrl` | `/uploads/<file>` |
| Banner / promo images | `image`, `image_url`, `imageUrl` | `/uploads/<file>` |
| Payment logos | `logoPath`, `logo`, `logoUrl` | `/uploads/<file>` |
| Notification images | `image` | `/uploads/notif-*` |
| **OTA APK downloads** | `apk_url`, `apkUrl` | `/uploads/apks/*.apk` |

**Popup settings** are text-only (no images).

Upload/admin flows still write files to `UPLOAD_DIR/apks/` on the API disk; only **download URLs** in API responses use Bunny.

## Backward compatibility

- DB may still hold legacy `https://osmani-admin-api.onrender.com/uploads/apks/...` — rewritten to Bunny on read.
- Direct `GET https://api.../uploads/...` from browsers returns **302** to Bunny when configured.
- **Bunny origin-pull** must receive **200 + file bytes** from the API (no redirect to b-cdn.net) — otherwise CDN URLs loop with 302.
- After fixing a redirect loop, **purge the Bunny pull zone cache** for `/uploads/*`.
- Play Store URLs are unchanged.
- If `BUNNY_CDN_BASE_URL` is unset, behavior matches pre-CDN (Render origin only).

## Verification

```bash
cd server
npm run verify:cdn-assets
npm run verify:apk-update-cdn
# or: npm run verify:apk-update-cdn -- https://osmani-admin-api.onrender.com

curl -s https://<api>/api/health/media | jq .cdn
curl -sI https://<api>/uploads/apks/<file>.apk   # 302 → b-cdn.net when CDN enabled
curl -s https://<api>/api/update-check | jq .apk_url
curl -s https://<api>/api/runtime/app-update | jq .apk_url
```

## Bandwidth impact (estimate)

| Traffic type | After CDN enabled |
|--------------|-------------------|
| Images (thumbnails, banners, logos) | Bunny edge (~0% Render egress) |
| **APK downloads** | **Bunny edge** (~0% Render egress for APK bytes) |
| API JSON / streams / webhooks | Render (unchanged) |

APK files are large (often 30–80+ MB each). Once OTA clients use `apk_url` from the API, **most remaining Render egress** from user downloads should shift to Bunny. Expect an additional **10–40%+ reduction** in total Render outbound (on top of image migration), depending on how often users download updates vs. browse images.

Measure: Render Metrics (outbound) vs Bunny bandwidth dashboard over 24–48h after deploy.
