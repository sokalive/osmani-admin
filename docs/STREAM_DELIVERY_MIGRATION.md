# Stream delivery migration (Phase 4)

Controlled migration from Render `stream-proxy` to signed **stream-direct** manifests and **Bunny CDN** HLS segments, with proxy rollback at every layer.

## Architecture (Step 3 — segment offload)

| Layer | Route / host | Role | Bandwidth |
|-------|----------------|------|-----------|
| **Playback entry** | `GET /stream-direct?token=…` | HMAC manifest fetch + rewrite | Small (manifest only) |
| **HLS segments (client)** | `https://<bunny>/hls/seg?tok=…` | Player downloads `.ts` / `.m4s` | **Zero direct client→Render** |
| **Bunny origin-pull** | `GET /hls/seg?tok=…` on API | Validates token, fetches upstream, caches at edge | **Cache miss only** |
| **Fallback** | `GET /stream-proxy?url=…` | Rewritten when Bunny off or hybrid bucket | Rollback path |
| **API fallback URL** | `proxy_playback_url` | Full proxy playback | Always available |

```text
Client ──► Bunny CDN (signed segment URL)
              │ cache HIT  → upstream bytes from edge (no Render)
              │ cache MISS → Render /hls/seg?tok=… → upstream provider

Client ──► Render /stream-direct?token=…  (manifest only, ~KB)
```

Upstream provider URLs are **never** exposed in API or manifest lines — only signed tokens.

## Environment

```bash
# Foundation
STREAM_DELIVERY_MODE=hybrid
DIRECT_STREAM_SIGNING_ENABLED=1
DIRECT_STREAM_SIGNING_SECRET=<32+ chars in Render dashboard>
DIRECT_STREAM_TOKEN_TTL_SEC=120          # manifest entry token
STREAM_SEGMENT_TOKEN_TTL_SEC=600         # per-segment Bunny URL token

# Segment offload (Step 3) — default: bunny + selective proxy for protected providers
STREAM_SEGMENT_DELIVERY=bunny            # proxy | bunny | hybrid
STREAM_SEGMENT_FORCE_PROXY=0             # 1 = global rollback (avoid in prod)
STREAM_SEGMENT_SELECTIVE_ROUTING=1       # 1 = ycn/tokenized → proxy, others → Bunny
STREAM_SEGMENT_PROTECTED_HOSTS=          # extra comma-separated host suffixes
STREAM_SEGMENT_PUBLIC_HOSTS=             # force Bunny (e.g. akamaized.net)
BUNNY_STREAM_CDN_BASE_URL=               # defaults to BUNNY_CDN_BASE_URL if set
BUNNY_STREAM_SEGMENT_PATH=hls/seg        # public path on Bunny zone
BUNNY_SEGMENT_CACHE_MAX_AGE_SEC=86400    # origin Cache-Control for .ts/.m4s
STREAM_SEGMENT_ROLLOUT_PERCENT=100       # hybrid mode: 0–100
STREAM_SEGMENT_ROLLOUT_SALT=osmani-seg-v1

# Optional: restrict origin-pull to Bunny (edge rule sends header)
BUNNY_PULL_ORIGIN_SECRET=<shared secret>
# Bunny edge rule: add request header X-Bunny-Origin-Auth: <secret>

# Cutover guardrails (playback manifest entry)
STREAM_PLAYBACK_FORCE_PROXY=1
DIRECT_STREAM_CUTOVER_ENABLED=0
DIRECT_STREAM_ROLLOUT_PERCENT=0
DIRECT_STREAM_ROLLOUT_CHANNEL_IDS=
```

## Selective segment routing (protected providers)

Default when `STREAM_SEGMENT_DELIVERY=bunny` and `STREAM_SEGMENT_SELECTIVE_ROUTING=1`:

| Provider type | Example | Segment URL in manifest |
|---------------|---------|-------------------------|
| **Public / CDN HLS** | `cdn.example.com/*.ts` | `https://osmanitv.b-cdn.net/hls/seg?tok=…` |
| **Protected (referer/token)** | `ycn-redirect.com`, `lanexa.online`, `?t=&e=` | `https://api…/stream-proxy?url=…` |

Auto-detected protected suffixes: `ycn-redirect.com`, `lanexa.online`, `netvidra.online`, `netstack.online`, plus `STREAM_SEGMENT_PROTECTED_HOSTS`.

### ycn / Bein header fix

Channel DB may store `origin` as `application/vnd.apple.mpegurl` (MIME type). That is **not** a valid HTTP `Origin` header and causes upstream 403/HTML responses. The API now normalizes before every upstream fetch:

- `Origin` → `https://het140c.ycn-redirect.com` (from referer/upstream host)
- `Referer` → inferred from upstream host when missing
- `User-Agent` → **desktop Chrome** for server-side ycn fetch (`STREAM_YCN_UPSTREAM_USER_AGENT`). Cloudflare blocks Exo/Android mobile UA from datacenter IPs; Exo on the phone only talks to our proxy.

Invalid HTML responses are no longer treated as HLS manifests (fixes false 500s during rewrite).

**Do not** set `STREAM_SEGMENT_FORCE_PROXY=1` for ycn issues — selective routing keeps most traffic on Bunny.

Metrics: `GET /api/health/stream-delivery` → `metrics.segment_routes_by_provider` (per-host bunny vs proxy counts).

## Bunny pull zone configuration

Use the **same** pull zone as static assets (`osmanitv.b-cdn.net`) or a dedicated stream zone.

1. **Origin URL:** `https://osmani-admin-api.onrender.com` (no trailing path)
2. **Host header:** forward client host or set to API host per Bunny docs
3. **Cache:** enable caching; segment responses send `Cache-Control: public, max-age=86400`
4. **Manifest origin responses:** `Cache-Control: no-store` (variant playlists rewritten per request)
5. **Optional edge rule:** add `X-Bunny-Origin-Auth` on origin requests; set matching `BUNNY_PULL_ORIGIN_SECRET` on API

Verify path mapping:

- Client requests: `https://osmanitv.b-cdn.net/hls/seg?tok=…`
- Bunny pulls: `https://osmani-admin-api.onrender.com/hls/seg?tok=…`

## Enabling segment offload (production-safe)

### Step 1 — Deploy code, keep proxy segments

```bash
STREAM_SEGMENT_DELIVERY=proxy
STREAM_SEGMENT_FORCE_PROXY=1
```

### Step 2 — Staging / test channel

```bash
STREAM_SEGMENT_DELIVERY=bunny
STREAM_SEGMENT_FORCE_PROXY=0
BUNNY_STREAM_CDN_BASE_URL=https://osmanitv.b-cdn.net
STREAM_PLAYBACK_FORCE_PROXY=0
DIRECT_STREAM_CUTOVER_ENABLED=1
DIRECT_STREAM_ROLLOUT_CHANNEL_IDS=<test-id>
```

Play test channel; confirm manifest segment lines use `osmanitv.b-cdn.net/hls/seg?tok=`.

### Step 3 — Hybrid percent

```bash
STREAM_SEGMENT_DELIVERY=hybrid
STREAM_SEGMENT_ROLLOUT_PERCENT=10   # → 25 → 50 → 100
```

### Step 4 — Full segment offload

```bash
STREAM_SEGMENT_DELIVERY=bunny
STREAM_SEGMENT_ROLLOUT_PERCENT=100
```

## Token refresh

| Token | TTL | Refresh |
|-------|-----|---------|
| Manifest (`stream-direct`) | `DIRECT_STREAM_TOKEN_TTL_SEC` (default 120s) | App re-fetches `playbackUrl` / channel list |
| Segment (`hls/seg?tok=`) | `STREAM_SEGMENT_TOKEN_TTL_SEC` (default 600s) | New manifest fetch issues new segment tokens (same session id within one manifest response) |

Manifest may include hints:

- `#EXT-X-OSMANI-SESSION:<id>`
- `#EXT-X-OSMANI-SEG-DELIVERY:bunny|proxy`

## Instant rollback

| Symptom | Action |
|---------|--------|
| Playback broken | `STREAM_PLAYBACK_FORCE_PROXY=1` |
| Segment issues only | `STREAM_SEGMENT_FORCE_PROXY=1` or `STREAM_SEGMENT_DELIVERY=proxy` |
| Direct rollout | `DIRECT_STREAM_CUTOVER_ENABLED=0` |

Redeploy after env change. No DB migration.

## Diagnostics

`GET /api/health/stream-delivery`

- `segments` — Bunny config, rollout, client path description
- `metrics.segment_urls_*` — bunny vs proxy rewrites
- `metrics.bunny_origin_fetch_*` — origin-pull success/failure (cache misses)
- `metrics.client_segment_*` — optional app reports

Optional client reports:

- `POST /api/stream-delivery/fallback` — playback fell back to proxy URL
- `POST /api/stream-delivery/segment-report` — body `{ "outcome": "cdn_ok" | "cdn_fail" | "proxy_fallback" }`

## API fields (additive)

| Field | Meaning |
|-------|---------|
| `playbackUrl` | Active URL (proxy or direct per rollout) |
| `proxy_playback_url` | Always Render proxy (fallback) |
| `direct_stream_url` | Signed direct entry |
| `stream_delivery_effective` | `direct` \| `proxy` |
| `streamProxy.playbackFallbackUrl` | Same as proxy URL |

## Premium / analytics / SSE

Unchanged: subscription, device, analytics, admin SSE, payment routes.

## Verify

```bash
cd server
npm run verify:stream-delivery
```

## Estimated bandwidth impact

| Traffic | Before Step 3 | After Step 3 (bunny mode) |
|---------|---------------|---------------------------|
| HLS segments (client→Render) | ~95–99% of stream GB | **~0%** |
| HLS segments (Bunny→Render origin) | 0 | **~5–15%** of stream GB (cache miss rate; improves over time) |
| Manifests | Small | Small (unchanged) |
| API / SSE / payments | Unchanged | Unchanged |

Example: 500 concurrent viewers × 2 Mbps ≈ **~1 Gbps** stream throughput. After cutover, Render sees manifest traffic (~10–50 KB per refresh per viewer) plus Bunny origin-pull on miss (often **90%+ reduction** once edge cache warms).

## Remaining Render traffic after cutover

- REST API, auth, subscription, payments, SSE
- Static upload origin (Bunny pull for `/uploads` on miss)
- `stream-direct` manifest requests
- `hls/seg` origin-pull on Bunny cache miss
- `stream-proxy` for rollback clients and hybrid/proxy segment mode
