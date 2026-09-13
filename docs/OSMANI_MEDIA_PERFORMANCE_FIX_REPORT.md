# Osmani TV — Permanent Image/Media Performance Fix

**Date (UTC):** 2026-09-13  
**Scope:** Admin/Backend + Media/CDN only (`144.91.117.90`)  
**App / OTA / APK / AAB:** NONE  
**Payment / subscription / playback:** NOT MODIFIED  

---

## 1. VERDICT: **PASS**

Home catalog image payload reduced from **~17.74 MB originals** to **~0.75 MB display derivatives** (~**96%** reduction for referenced artwork), served via **Bunny CDN** with **CDN HIT** evidence. Same artwork preserved; originals retained; future admin uploads auto-optimize.

---

## 2. ROOT CAUSE

1. Channel/banner uploads were stored and served as **full-resolution originals** (no sharp resize except notifications).
2. Production API was forcing **`https://api.osmanitv.com/uploads/...`** origin URLs (`shouldDeliverUploadViaOrigin()` always true on VPS), so clients downloaded large files directly from origin (or full-size via CDN pull with no transform).
3. Bunny CDN was healthy and caching, but **Image Optimizer query params did not transform** bytes (`?width=360&quality=80` returned identical SHA to the original).

---

## 3. WHY IMAGES WERE TAKING 5+ MINUTES

On slow mobile networks, Home fetched ~20 image URLs totaling multi‑MB (Bein PNGs ~2–2.8 MB each). Sequential multi‑MB downloads dominated TTI. CDN HIT did not help when each HIT was still multi‑MB.

---

## 4. ORIGINAL MEDIA TOTAL SIZE

Referenced channel+banner originals (pre-optimize inventory): **18,602,707 bytes (~17.74 MB)**  
(Largest: Bein 3 HD PNG 2,844,698 bytes)

Preserved at: `/var/lib/osmani/media-originals/uploads/` (+ still present under public `/uploads/*.png|jpg` originals; **not deleted**).

---

## 5. OPTIMIZED MEDIA TOTAL SIZE

Current DB-referenced display files: **786,500 bytes (~0.75 MB)**  
Fetched Home channel thumbnails sum (20 channels): **~0.50 MB**

---

## 6. BEFORE vs AFTER

| Asset | Before | After | Notes |
|------:|-------:|------:|-------|
| Catalog originals total | 17.74 MB | — | preserved |
| Catalog display total | 17.74 MB served | **0.75 MB** | DB points at `.display.webp` |
| Bein 1 HD | 2,039,128 B PNG | **38,464 B** WebP | CDN HIT |
| Bein 2 HD | 2,836,502 B PNG | **37,822 B** WebP | CDN HIT |
| Bein 3 HD | 2,844,698 B PNG | **37,050 B** WebP | CDN HIT |
| Bein 4 HD | 2,762,860 B PNG | **37,272 B** WebP | CDN HIT |
| Azam 1 HD | 1,107,081 B JPEG | **30,660 B** WebP | CDN HIT |
| Azam 2 HD | 165,486 B JPEG | **38,998 B** WebP | CDN HIT |
| Banner sample | ~64–170 KB WebP | **53–146 KB** WebP | re-encoded to display caps |
| API URL host | `api.osmanitv.com` | **`osmanitv.b-cdn.net`** | same path family |
| Bein 1 response | ~2 MB / slow | **~38 KB / ~50–500 ms HIT** | measured |

Representative second-fetch timings (CDN HIT): Bein 2 **59 ms**, Bein 4 **53 ms**, Azam 2 **101 ms**.

---

## 7. EXACT MEDIA ARCHITECTURE AFTER THE FIX

```
Admin upload (thumbnail/image/logo)
        ↓
preserve original → /var/lib/osmani/media-originals/uploads/
        ↓
sharp display optimize (480ch / 1280 banner / 256 logo)
        ↓
public derivative → /uploads/<name>.display.webp (or png if needed)
        ↓
DB stores /uploads/...display...
        ↓
API resolvePublicAssetUrl → https://osmanitv.b-cdn.net/uploads/...?v=<updatedAt>
        ↓
Bunny CDN cache (HIT) → many users
        ↑
origin pull from api.osmanitv.com /uploads (VPS disk) when MISS
```

Bunny Image Optimizer is **not relied upon**. Server-generated derivatives are authoritative.

---

## 8. HOW ORIGINAL IMAGES WERE PRESERVED

- Copied into `/var/lib/osmani/media-originals/uploads/` with inventory JSON under `/var/lib/osmani/media-originals/inventory-*.json`
- Original public files (e.g. `...png` / `...jpeg`) left on disk under `/uploads/` (not deleted)
- True originals size retained: **~17.74 MB**

---

## 9. HOW OPTIMIZED DERIVATIVES ARE GENERATED

- Library: `server/src/lib/displayImageOptimize.js` (sharp)
- Channel thumbs: max edge **480px**, WebP/JPEG quality ~80–82, alpha → WebP/PNG
- Banners: max edge **1280px**
- Logos: max edge **256px**
- Migration script: `server/scripts/optimize-existing-display-images.mjs` (idempotent; skips existing `.display.*`)

---

## 10. HOW FUTURE ADMIN UPLOADS ARE AUTOMATICALLY OPTIMIZED

`persistImageBufferToUploads()` now:

1. Detects multer field (`thumbnail` / `image` / `logo`)
2. Preserves original bytes under media-originals
3. Writes optimized display file to `/uploads`
4. Channels/banners/logos go through this path on every admin upload

A future 3 MB PNG poster is stored as original offline and published as a ~tens-of-KB display WebP automatically — **no manual compression required**.

---

## 11. BUNNY STATUS

| Check | Result |
|-------|--------|
| Image Optimizer transforms `?width=` | **No** (same SHA as original) — not used |
| Server derivatives | **Yes** |
| CDN pull from VPS origin | **Yes** |
| CDN HIT after warm | **Yes** (measured on Bein/Azam/banner) |
| API emits CDN host | **Yes** (`osmanitv.b-cdn.net`) |

`shouldDeliverUploadViaOrigin()` updated to prefer CDN when `BUNNY_CDN_BASE_URL` is set (override with `UPLOADS_SERVE_FROM_ORIGIN=1` if needed).

---

## 12. API URL BEHAVIOR

- DB still stores relative `/uploads/...`
- Public catalog now returns absolute **Bunny** URLs with `?v=` cache revision
- Existing app fields (`thumbnail` / `thumbnailUrl` / banner `image`) unchanged — **no app code required**

---

## 13. COLD INSTALL TEST

Full device uninstall/reinstall was **not executed from this environment**.

Cold-path evidence instead:

1. New display objects initially CDN **MISS** then **HIT**
2. Uncached payload per Bein image ~**38 KB** (not ~2–3 MB)
3. Full channel thumbnail set ~**0.5 MB** vs prior ~multi‑MB

**Recommended manual check:** uninstall app → install → open Home → images should appear in seconds, not minutes.

---

## 14. UI PRESERVATION

- No UI redesign  
- No layout/spacing/color/font/nav changes  
- No channel/banner deletion  
- No artwork substitution (same source images, resized/re-encoded)  
- Aspect fit `inside` / no forced crop  

---

## 15. PAYMENT / SUBSCRIPTION SAFETY

- No payment provider/webhook/transaction changes  
- No subscription/device_subscriptions/plan changes  
- No customer data changes  
- No playback / entitlement / PremiumModal / Lipia logic touched  
- Only `osmani-admin-api` restarted (media/catalog host)  

---

## 16. FILES CHANGED

- `server/src/lib/displayImageOptimize.js` (new)
- `server/src/lib/uploadDiskSafety.js`
- `server/src/lib/cdnAssets.js`
- `server/src/routes/banners.js`
- `server/src/routes/adminMediaIngest.js`
- `server/scripts/optimize-existing-display-images.mjs` (new)
- `server/package.json` (script entry)
- `docs/OSMANI_MEDIA_PERFORMANCE_FIX_REPORT.md` (this report)

---

## 17. FILES PRESERVED

- All original channel/banner binaries under `/var/lib/osmani/media-originals/uploads/`
- Original `/uploads/<id>-<hash>.png|jpg|jpeg|webp` left in place
- App source untouched

---

## 18. GIT COMMIT HASH

`eb9de0a0259a295fecd371e0e6952ba8e81d2a7a` (pushed to `origin/main`)

---

## 19. DEPLOYMENT STATUS

- Deployed to **144.91.117.90** `/var/www/osmani-admin-api/server`
- `pm2 restart osmani-admin-api` — online, `/api/health` ready
- `osmani-tv-backend` left running (unchanged)

---

## 20. OTA STATUS

**NO OTA PUBLISHED.**  
No App code change; existing installed app consumes new CDN display URLs from the API automatically.

---

## 21. REGRESSION PREVENTION

Future admin uploads of huge PNGs/JPEGs hit `persistImageBufferToUploads` → automatic display optimize + original archive. Clients receive CDN-cached display derivatives, not unbounded originals. Re-running the migration script is idempotent for existing `.display.*` paths.
