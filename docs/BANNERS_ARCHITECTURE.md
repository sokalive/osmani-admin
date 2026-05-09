# Featured banners — architecture and rollout

This document describes how the Osmani admin banner system aligns with a **Lovable-style featured banner** workflow (scheduling, automatic status badges, ordering) without replacing the existing admin shell UI.

## Comparison: prior admin vs target capabilities

| Capability | Before | Now |
| --- | --- | --- |
| Event date range (`event_start` / `event_end`) | Yes | Yes |
| Daily repeat window (`event_timer` + `daily_start` / `daily_end`) | Yes | Yes |
| Manual badge text + styling | Yes | Yes; optional |
| **Automatic badge labels** (LIVE NOW, COMING SOON, COMING NEXT, ENDED) | Partial / manual | **Server + preview:** `server/src/bannerScheduleEngine.js`, mirrored preview in `src/utils/bannerAutomationClient.js` |
| Sort order + drag-and-drop | Yes | Yes |
| Live preview in modal | Yes (schedule helpers) | Yes; preview uses same automation rules |
| Public API semantics | Raw DB `badge` | **`badge`** is **display** (automated or manual); **`badge_manual`** when automation is on |

## Database

### Column added

- **`badge_automation`** (`BOOLEAN NOT NULL DEFAULT true`)

Defined and migrated in `server/src/db/bannersTable.js` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

### Migration behavior for existing rows

On deploy, when the column is first present:

- Existing rows with **non-empty** `badge` text are set to **`badge_automation = false`** so legacy custom copy is preserved and still shown.
- Empty-badge rows keep automation **on** (default).

No destructive schema changes; only additive column + one-time data fix.

## API and normalization

- **`GET /api/banners`**: public list; each row is augmented with `schedule_phase`, `computed_badge`, effective display `badge`, `badge_manual` (when applicable), and visibility flags. See `server/src/bannerNormalize.js`.
- **`GET /api/banners/manage`**: same automation map for admin listing/editing; manage payloads expose both stored fields and computed **`effectiveBadge`** / **`schedulePhase`** where relevant.
- Automation is computed once per request via **`computeAutomationForAll`** in `server/src/bannerScheduleEngine.js`.

### Consumer note (breaking-ish)

Clients that assumed **`GET /api/banners`** `.badge` was always the **stored** DB string should switch:

- Use **`badge`** for **what to show** (automated or manual).
- Use **`badge_manual`** / camelCase **`badgeManual`** when you need the admin-entered text while automation is enabled.

## Environment

- **`BANNER_COMING_SOON_HOURS`** — hours before `event_start` during which a banner may show **COMING SOON** (default **72**). Aligns with preview constant in `src/utils/bannerAutomationClient.js`.

## Realtime

Banner create/update/delete continues to notify the app through the existing mechanism (e.g. **`config.banners_changed`** / live sync bus). No changes to auth, payments, transfers, or unrelated APIs.

## Media / uploads

Banner images remain URLs backed by **`GET /uploads/*`** and **`UPLOAD_DIR`** as documented in `docs/DEPLOYMENT_MEDIA.md`. No change to upload storage layout.

## Deployment checklist

1. Deploy API **before or with** admin static site so new fields exist when the editor saves `badgeAutomation`.
2. Ensure PostgreSQL migrations run on startup (existing `ensureBannersTable` path) so **`badge_automation`** exists.
3. Optionally set **`BANNER_COMING_SOON_HOURS`** on the API service if you want a non-default window.
4. Verify **`GET /api/banners`** and admin **Banners** page show expected phases after deploy.

## Files of reference

| Area | Path |
| --- | --- |
| Automation engine | `server/src/bannerScheduleEngine.js` |
| Row shaping (public vs manage) | `server/src/bannerNormalize.js` |
| Routes / parsing | `server/src/routes/banners.js` |
| Store / listing filters | `server/src/bannerStore.js` |
| Table DDL + migration | `server/src/db/bannersTable.js` |
| Modal preview helpers | `src/utils/bannerAutomationClient.js` |
| Admin UI | `src/pages/BannersPage.jsx`, `src/components/BannerFormModal.jsx` |
