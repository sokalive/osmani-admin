# Stream delivery migration (Phase 4)

Foundation for moving HLS playback off Render `stream-proxy` toward signed direct / CDN paths **without** changing current client behavior.

## Current state (Step 1)

| Item | Behavior |
|------|----------|
| `playbackUrl` | **Still Render proxy** (`STREAM_PLAYBACK_FORCE_PROXY=1` default) |
| `stream-proxy` | Unchanged fallback for all existing apps |
| `direct_stream_url` | Additive API field (signed `/stream-direct?token=…`) when signing is configured |
| `stream_delivery_mode` | Global mode from env: `proxy` \| `direct` \| `hybrid` |
| Production cutover | **Not enabled** |

## Environment

```bash
STREAM_DELIVERY_MODE=hybrid
DIRECT_STREAM_SIGNING_ENABLED=1
DIRECT_STREAM_SIGNING_SECRET=<min 16 chars — set in Render dashboard only>
STREAM_PLAYBACK_FORCE_PROXY=1          # default; keep 1 until cutover plan
DIRECT_STREAM_TOKEN_TTL_SEC=120
# Optional: DIRECT_STREAM_BASE_URL=https://osmani-admin-api.onrender.com
```

## API fields (additive)

On each channel from `GET /api/channels`:

- `playbackUrl` — unchanged semantics (proxy URL today)
- `direct_stream_url` — signed short-TTL entry URL (null if signing off/unconfigured)
- `stream_delivery_mode` — `hybrid` / `proxy` / `direct`
- `direct_stream_url_backup1` / `direct_stream_url_backup2` — backups
- `streamProxy` — extended with `directRoute`, `directPrimaryUrl`, `playbackSource`

Older clients ignore new fields.

## Routes

| Route | Purpose |
|-------|---------|
| `GET /stream-proxy?url=…` | Existing proxy (fallback + current playback) |
| `GET /stream-direct?token=…` | HMAC-validated; same fetch/rewrite engine as proxy |

## Health

`GET /api/health/stream-delivery` — mode, signing status, cutover flags, routes.

## Modes

| Mode | API `direct_stream_url` | `playbackUrl` (with force proxy) |
|------|-------------------------|----------------------------------|
| `proxy` | hidden | proxy |
| `hybrid` | exposed when signing on | proxy |
| `direct` | exposed when signing on | proxy (until `STREAM_PLAYBACK_FORCE_PROXY=0`) |

## Future cutover (not Step 1)

1. Configure Bunny (or other) pull zone for stream origins where applicable.
2. Load-test `direct_stream_url` with staging app build.
3. Set `STREAM_PLAYBACK_FORCE_PROXY=0` and/or app prefers `direct_stream_url`.
4. Monitor Render proxy bandwidth drop; keep proxy for legacy app versions.

## Rollback

1. Set `DIRECT_STREAM_SIGNING_ENABLED=0` **or** remove `DIRECT_STREAM_SIGNING_SECRET`.
2. Ensure `STREAM_PLAYBACK_FORCE_PROXY=1`.
3. Redeploy — `direct_stream_url` becomes null; clients use `playbackUrl` only.

No DB migration. No APK required for rollback.

## Verify

```bash
cd server
npm run verify:stream-delivery
curl -s https://<api>/api/health/stream-delivery | jq
```
