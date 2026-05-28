# Phase 2 — Static assets on Bunny CDN

Uploaded images stay on disk under `UPLOAD_DIR` and in the database as `/uploads/...` paths. **API responses** expose absolute **Bunny** URLs when `BUNNY_CDN_BASE_URL` is set.

## Configure Bunny

1. Create a **Pull Zone** in Bunny.net pointing at your API origin, e.g. `https://osmani-admin-api.onrender.com`.
2. Enable **origin shield** / caching for `GET` on `/uploads/*`.
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

**Not migrated (OTA unchanged):** `/uploads/apks/*` — still served from `BASE_URL`.

**Popup settings** are text-only (no images).

## Backward compatibility

- DB paths remain `/uploads/...`.
- Legacy absolute URLs on `*.onrender.com` are rewritten to Bunny on read.
- Direct `GET https://api.../uploads/foo.jpg` returns **302** to Bunny when configured, with `Link: <origin>` alternate.
- If `BUNNY_CDN_BASE_URL` is unset, behavior matches pre–Phase 2 (Render origin only).

## Verification

```bash
cd server
npm run verify:cdn-assets
curl -s https://<api>/api/health/media | jq .cdn
curl -sI https://<api>/uploads/<sample-image>.jpg   # expect 302 to b-cdn.net when CDN enabled
curl -s https://<api>/api/channels | jq '.[0].thumbnailUrl'
curl -s https://<api>/api/banners | jq '.[0].imageUrl'
```

## Bandwidth impact (estimate)

Typical TV app traffic is dominated by **image bytes**, not JSON. After clients receive CDN URLs:

| Traffic type | Before | After (CDN enabled) |
|--------------|--------|---------------------|
| Channel thumbnails | ~100% Render egress | ~0% Render (Bunny edge) |
| Banners / logos / push images | Render | Bunny |
| APK downloads | Render | Render (unchanged) |
| API JSON | Render | Render (unchanged) |

**Rule of thumb:** if static images are ~70–90% of API egress, expect **~70–90% reduction** in Render bandwidth for media once the pull zone is warm and clients use returned CDN URLs. Measure in Render Metrics (outbound) vs Bunny dashboard after 24–48h.
