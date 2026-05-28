# Stream delivery migration (Phase 4)

Controlled migration from Render `stream-proxy` to signed **stream-direct** entry with proxy fallback and rollout guardrails.

## Architecture (Step 2)

| Layer | Route | Role |
|-------|-------|------|
| **Playback entry (rolled out)** | `GET /stream-direct?token=…` | HMAC-validated manifest fetch |
| **HLS segments** | `GET /stream-proxy?url=…` | Rewritten segment URLs (stable today) |
| **Fallback** | `proxy_playback_url` in API | Always available on each channel |

Future: Bunny pull zone for segments (Step 3+).

## Environment

```bash
# Foundation
STREAM_DELIVERY_MODE=hybrid
DIRECT_STREAM_SIGNING_ENABLED=1
DIRECT_STREAM_SIGNING_SECRET=<32+ chars in Render dashboard>
DIRECT_STREAM_TOKEN_TTL_SEC=120

# Cutover guardrails (default safe)
STREAM_PLAYBACK_FORCE_PROXY=1              # 1 = all playbackUrl stay proxy (rollback)
DIRECT_STREAM_CUTOVER_ENABLED=0            # 1 = allow rollout rules below
DIRECT_STREAM_ROLLOUT_PERCENT=0            # 0–100 when no allowlist
DIRECT_STREAM_ROLLOUT_CHANNEL_IDS=         # e.g. 12,45,99 (test channels)
DIRECT_STREAM_ROLLOUT_SALT=osmani-v1       # stable percent hashing
```

## Controlled cutover process

### Phase A — Test allowlist only

```bash
STREAM_PLAYBACK_FORCE_PROXY=0
DIRECT_STREAM_CUTOVER_ENABLED=1
DIRECT_STREAM_ROLLOUT_CHANNEL_IDS=12,34    # 1–3 test channels
DIRECT_STREAM_ROLLOUT_PERCENT=0
```

Redeploy → only listed channels get `playbackUrl` = signed `stream-direct`. Others stay proxy.

Verify:

```bash
curl -s https://<api>/api/health/stream-delivery | jq .rollout,.metrics
curl -s https://<api>/api/channels | jq '.[] | select(.id==12) | {playbackUrl,proxy_playback_url,stream_delivery_effective}'
```

Play channel 12 in app; confirm playback. On failure, app should use `proxy_playback_url` (future app) or manual test proxy URL.

### Phase B — Percentage rollout

```bash
DIRECT_STREAM_ROLLOUT_CHANNEL_IDS=
DIRECT_STREAM_ROLLOUT_PERCENT=10          # then 25, 50, 100
```

Same channel id always gets same decision (hash bucket).

### Phase C — Full cutover (optional)

```bash
DIRECT_STREAM_ROLLOUT_PERCENT=100
# or STREAM_DELIVERY_MODE=direct
```

Keep `/stream-proxy` live for fallback and legacy clients.

## API fields (additive)

| Field | Meaning |
|-------|---------|
| `playbackUrl` | Active URL (proxy or direct per rollout) |
| `proxy_playback_url` | Always Render proxy (fallback) |
| `direct_stream_url` | Signed direct entry |
| `stream_delivery_effective` | `direct` \| `proxy` |
| `direct_stream_rollout` | Channel included in rollout |
| `streamProxy.playbackFallbackUrl` | Same as proxy URL |

## Instant rollback

Any one (fastest first):

1. `STREAM_PLAYBACK_FORCE_PROXY=1` → redeploy  
2. `DIRECT_STREAM_CUTOVER_ENABLED=0` → redeploy  
3. `DIRECT_STREAM_ROLLOUT_PERCENT=0` and clear allowlist  

No DB migration. Old APKs keep using `playbackUrl` (returns proxy again).

## Diagnostics

`GET /api/health/stream-delivery` includes:

- `rollout` — percent, allowlist, cutover flags  
- `metrics` — direct/proxy success, token failures, client fallback reports  

Optional client report (future app builds):

`POST /api/stream-delivery/fallback` — increments `client_fallback_reported`.

## Token safety

- TTL default **120s** (`DIRECT_STREAM_TOKEN_TTL_SEC`)  
- Expired/invalid tokens → 403/400 + metric counters  
- Upstream URL never returned unsigned in API  

## Premium / analytics / SSE

Unchanged: subscription, device, analytics, admin SSE, payment routes.

## Verify

```bash
cd server
npm run verify:stream-delivery
```

## Bandwidth estimate (when rollout enabled)

| Stage | Render egress impact |
|-------|----------------------|
| Allowlist only (few channels) | Small reduction on manifest path |
| 50% rollout | ~25–40% of stream-proxy **manifest** traffic moves to stream-direct entry; **segments still proxy** until Bunny |
| 100% + future Bunny segments | **Large** reduction (majority of bytes leave Render) |

Today’s Step 2 shifts **playbackUrl** and manifest auth to stream-direct; segment bytes still hit stream-proxy until CDN edge migration.
