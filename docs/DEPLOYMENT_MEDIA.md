# Media uploads — persistent storage (Render)

Uploaded images (banners, channel thumbnails, payment provider logos) are stored on disk and served at **`GET /uploads/*`**. The application resolves the filesystem root from **`UPLOAD_DIR`** (falls back to `server/uploads` only for local development).

## Why uploads disappeared

On Render, the container filesystem is **ephemeral** unless you write under a **persistent disk** (or use external object storage). Builds and deploys replace the image; anything under the old repo path `server/uploads` is lost unless it lives on a mounted volume.

## Render checklist

1. **Attach a persistent disk** to the **API web service** (not the static admin site).
   - Example mount path: `/var/render/media`
   - Minimum **Starter** (or higher) plan — free web services cannot attach disks.

2. **Set environment variable** on that service (must match the disk mount):
   - `UPLOAD_DIR=/var/render/media`

3. **Apply Blueprint** (optional): this repo’s `render.yaml` declares `osmani-admin-api` with `disk.mountPath` and `UPLOAD_DIR` aligned. If you already have an API service with a different name, set the same env + disk on that service instead of creating a duplicate.

4. **Redeploy** after changing disk or env. Watch logs for:
   - `[uploads] resolved UPLOAD_DIR: ...`
   - `[uploads] image file count: N`

5. **Migrate existing files** from a backup or old container path into `UPLOAD_DIR` (see below).

## Verification

- **Startup logs**: directory path, existence, file count, sample filenames.
- **Health**: `GET /api/health/media` — returns `ok`, `writable`, `fileCount`, `sampleReadOk`, `uploadsDir`.
- **Sample image**: open `https://<api-host>/uploads/<filename>` — must return image bytes with correct `Content-Type`, not JSON.

## Cache / CDN

When **`BUNNY_CDN_BASE_URL`** is set (see [CDN_STATIC_ASSETS.md](./CDN_STATIC_ASSETS.md)):

- Public APIs return `https://*.b-cdn.net/uploads/...` for images and APKs (`apk_url`).
- `GET /uploads/*` on the API origin serves files directly (required for Bunny pull-zone). Public APIs return Bunny URLs.
- Origin cache uses long `max-age` for immutable filenames.

When Bunny is **not** configured, `/uploads/*` uses `Cache-Control: public, max-age=0, must-revalidate` and **ETag** support. Missing files return **plain text** `Not found`, not the JSON API 404 body.

## Migrate / restore files

From the `server/` directory, after setting `UPLOAD_DIR` to the live disk path (or testing locally):

```bash
# Dry run
UPLOAD_DIR=/var/render/media node scripts/migrate-uploads.mjs --from /path/to/backup/uploads --dry-run

# Copy
UPLOAD_DIR=/var/render/media node scripts/migrate-uploads.mjs --from /path/to/backup/uploads
```

Restore anything referenced in Postgres / JSON that starts with `/uploads/` — filenames must exist under `UPLOAD_DIR`.

## Future deploys

Deploys **do not wipe** data under the persistent disk mount. Only changing `mountPath`, destroying the disk, or pointing `UPLOAD_DIR` elsewhere will orphan files.
