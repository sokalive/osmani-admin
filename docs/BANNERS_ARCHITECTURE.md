# Featured banners — architecture and rollout

This document describes how the Osmani admin banner system aligns with a **Lovable-style featured banner** workflow (scheduling, automatic status badges, ordering) without replacing the existing admin shell UI.

## Comparison: prior admin vs target capabilities

| Capability | Before | Now |
| --- | --- | --- |
| Event date range (`event_start` / `event_end`) | Yes | Yes |
| Daily repeat window (`event_timer` + `daily_start` / `daily_end`) | Yes | Yes |
| Manual badge text + styling | Yes | Styling only; status text is automated |
| **Automatic badge labels** (LIVE NOW, COMING SOON, COMING NEXT, ENDED) | Partial / manual | **Server + preview:** `server/src/bannerScheduleEngine.js`, mirrored preview in `src/utils/bannerAutomationClient.js` |
| Sort order + drag-and-drop | Yes | Yes |
| Live preview in modal | Yes (schedule helpers) | Yes; preview uses same automation rules |
| Public API semantics | Raw DB `badge` | **`badge`** is **display** (automated or manual); **`badge_manual`** when automation is on |
| **Day-of-week** for daily repeat | N/A | **`weekday_mask`** (0–127, Sun=bit0 … Sat=bit6). Default **127** = all days; existing rows unchanged. |
| Admin schedule UI | Basic timer | **Scheduling** section: one-time vs daily repeat, weekdays, schedule + transition preview (matches engine). |
| Event timer vs visibility | Previously mixed | Timer now drives badge/countdown/repeat state only; active banners stay visible in admin preview cards. |

## Database

### Columns added (additive migrations)

- **`badge_automation`** (`BOOLEAN NOT NULL DEFAULT true`)
- **`weekday_mask`** (`SMALLINT NOT NULL DEFAULT 127`) — bitmask of allowed weekdays when **`event_timer`** is true; ignored for effective visibility when daily repeat is off (engine treats non-repeat banners as “any day”).
- **`repeat_mode`** (`TEXT NOT NULL DEFAULT 'none'`) — explicit runtime repeat mode (`none` or `daily`).
- **`timezone`** (`TEXT`) — schedule timezone metadata for runtime compatibility.

Defined and migrated in `server/src/db/bannersTable.js` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

### Migration behavior for existing rows

On deploy, when the column is first present:

- Existing rows with **non-empty** `badge` text are set to **`badge_automation = false`** so legacy custom copy is preserved and still shown.
- Empty-badge rows keep automation **on** (default).
- **`weekday_mask`** defaults to **127** (all days) for all existing rows, so legacy daily-repeat banners behave as before.

No destructive schema changes; only additive column + one-time data fix.

### Validation (API)

When **`event_timer`** is true: daily start/end required, start ≠ end (same clock minute), and **`weekday_mask`** must have at least one weekday bit set (server returns **400** with a clear message).

## API and normalization

- **`GET /api/banners`**: public list; each row is augmented with `schedule_phase`, `computed_badge`, effective display `badge`, `repeat_mode`, `timezone`, and visibility flags. See `server/src/bannerNormalize.js`.
- **`GET /api/banners/manage`**: same automation map for admin listing/editing; manage payloads expose both stored fields and computed **`effectiveBadge`** / **`schedulePhase`** where relevant.
- **`GET /api/settings`**: includes `banner_engine` / `bannerEngine` config block (`sseEvent`, defaults, and `comingSoonHours`).
- ENDED phase now has a 3-minute grace window before automatic transition label: `NEXT COMING SOON X:XX`.
- Automation is computed once per request via **`computeAutomationForAll`** in `server/src/bannerScheduleEngine.js`.

### Consumer note (breaking-ish)

Clients that assumed **`GET /api/banners`** `.badge` was always the **stored** DB string should switch:

- Use **`badge`** for **what to show** (automated or manual).
- Use **`badge_manual`** / camelCase **`badgeManual`** when you need the admin-entered text while automation is enabled.

## Environment

- **`BANNER_COMING_SOON_HOURS`** — hours before `event_start` during which a banner may show **COMING SOON** (default **72**). Aligns with preview constant in `src/utils/bannerAutomationClient.js`.

## Realtime

Banner create/update/delete emits SSE event **`banners_changed`** through live sync bus (topic `config`). No changes to auth, payments, transfers, or unrelated APIs.

## Media / uploads

Banner images remain URLs backed by **`GET /uploads/*`** and **`UPLOAD_DIR`** as documented in `docs/DEPLOYMENT_MEDIA.md`. No change to upload storage layout.

## Deployment checklist

1. Deploy **backend first** so migrations (`repeat_mode`, `timezone`) and SSE event `banners_changed` are live.
2. Deploy **mobile second** (`feat/lovable-banner-engine`) so runtime consumes `repeat_mode` / `timezone` and listens to `banners_changed`.
3. Deploy **admin UI third** so editor sends `repeatMode` / `timezone` controls.
4. Ensure PostgreSQL migrations run on startup (existing `ensureBannersTable` path) so new columns exist.
5. Optionally set **`BANNER_COMING_SOON_HOURS`** on the API service if you want a non-default window.

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
