# Render service sizing (Phase 3 Step 4)

Analysis based on this repo’s architecture, production health checks (May 2026), and optimizations already shipped (Bunny CDN, API response cache, polling reduction).

> **Live RAM/CPU charts** are only in the [Render Dashboard](https://dashboard.render.com) → each service → Metrics. This document infers utilization from code paths and post-optimization traffic shape.

---

## 1. Services in scope

| Service | In repo | Blueprint / typical plan | Role |
|---------|---------|--------------------------|------|
| **osmani-admin-api** | Yes (`render.yaml`) | **Starter** ($7/mo) + **1 GB disk** | Node API, Postgres client, stream proxy, SSE, uploads mount |
| **osmani-admin-mpya** | Yes | **Static** (free) | Vite admin SPA |
| **osmani-tv** / **osmani-tv-web** | Not in this repo | Unknown | Likely separate web/player service — **size via Dashboard only** |

Production API commit observed: `6ef0e0c` · CDN: `https://osmanitv.b-cdn.net` · disk: 86 files under `/var/render/media`.

---

## 2. RAM & CPU — osmani-admin-api (inferred)

### Memory drivers

| Component | Approx. impact | Notes |
|-----------|----------------|-------|
| Node 20 runtime | ~80–120 MB baseline | Single process |
| Express + routers | ~20–40 MB | Grows with concurrent requests |
| `pg` pool (`PG_POOL_MAX` default **8**) | ~2–5 MB per connection | Was hardcoded 10 |
| In-memory API cache | **Bounded** (48 entries) | Small JSON payloads |
| SSE connections | ~50–200 KB per open stream | Scales with concurrent `/subscription-stream` |
| Stream proxy | Spikes per playback | Manifest rewrite; not full segment buffering |
| Multer APK upload | **Spike** to APK size (≤300 MB env cap) | Rare; admin-only |

**Starter = 512 MB RAM.** After CDN + API cache, typical idle is often **150–280 MB** unless many SSE clients or an APK upload is in progress. **Downgrading RAM below Starter is not available on Render** while using a persistent disk.

### CPU drivers (idle vs peak)

| Workload | Before optimizations | After CDN + API cache |
|----------|---------------------|------------------------|
| `GET /api/channels` | DB + N× `channelToResponse` every poll | **Cache hit** → no DB (20s TTL) |
| `GET /uploads/*` images/APKs | Render egress + disk read | **302 to Bunny**; origin barely touched |
| Background channel probes | Every **30s**, all channels HTTP probed | **Off by default** (this step) |
| Payment webhooks | Bursty | Unchanged — must stay reliable |
| `GET /stream-proxy` | Per viewer segment/manifest | Unchanged — do not throttle |
| Analytics janitor | Every 10s DELETE | Light |
| Notification flush | Every 30s | Light |

**Peak CPU:** concurrent streams (proxy) + payment webhooks + cold cache miss on large channel list.

---

## 3. PostgreSQL

- Single `DATABASE_URL` pool in `server/src/db/pool.js`.
- **No schema migration required** for sizing tweaks.
- Check Dashboard: storage %, active connections, CPU.

### Safe connection tuning (implemented)

```bash
PG_POOL_MAX=8                    # default; raise only if you scale to multiple API instances
PG_POOL_IDLE_TIMEOUT_MS=30000
```

Render Postgres **Starter** allows limited connections; one API instance at 8 is usually enough. If you add a second API instance, use **Render connection pooling** or PgBouncer URL instead of doubling `PG_POOL_MAX` on each node.

### DB plan opportunities (Dashboard only)

| Action | Risk | Savings |
|--------|------|---------|
| Right-size disk (GB actually used) | Low | $1–5+/mo on paid storage tiers |
| Drop unused read replica | Low | Full replica cost |
| Stay on smallest tier if CPU < 25% avg | Low | $0–15+/mo vs larger tier |
| Aggressive downgrade while peaky | **High** | Not recommended |

---

## 4. Traffic shape after CDN + cache

- **Egress:** Mostly shifted to Bunny (images, APKs, redirects).
- **API JSON:** Still Render-bound; volume reduced when clients poll catalog less and server cache hits.
- **DB:** Catalog reads drop on cache HIT (~70–95% for hot endpoints).
- **Disk I/O:** Admin uploads + Bunny origin pull only.

---

## 5. Is anything oversized?

| Asset | Verdict |
|-------|---------|
| **osmani-admin-api Starter + 1GB disk** | **Appropriate minimum** for persistent uploads + stream proxy. Not safely reducible to Free. |
| **osmani-admin-mpya Static** | Already minimal cost. |
| **Background health probes (all channels)** | Was **oversized** for 24/7 — now **disabled by default**. |
| **Postgres** | Verify in Metrics; may be oversized if tier > actual storage/CPU. |
| **osmani-tv** | Unknown — inspect separately. |

---

## 6. Recommendations (safest → riskiest)

### Tier 1 — Do now (code/env, no tier change)

1. **Keep `SERVER_HEALTH_BACKGROUND_ENABLED=0`** (default) — saves continuous outbound probes. Admin health page still works via GET `/api/server-health` + SSE on channel changes.
2. **Keep API cache enabled** (`API_CACHE_ENABLED=1`).
3. **Set `PG_POOL_MAX=8`** (default) on single instance.
4. **Confirm one API instance** (no accidental 2× Starter for same service).

### Tier 2 — Dashboard checks (no downgrade yet)

5. Render → **osmani-admin-api** → Metrics: 7-day RAM p95, CPU p95, HTTP requests.
6. Postgres → storage used, connection count p95.
7. If RAM p95 < 40% and CPU p95 < 30% for 7 days, note headroom — still **cannot** drop below Starter with disk.

### Tier 3 — Cost cuts when metrics support

8. **Postgres storage/tier** downsize if disk & CPU low (safest dollar savings).
9. **Remove duplicate/unused Render services** (old APIs, test workers).
10. **osmani-tv**: if Static or idle Starter, align to Static or sleep (if not user-facing 24/7).

### Tier 4 — Do not do without migration plan

11. Move API to Free tier without disk (loses persistent uploads unless Bunny Storage API + DB URL-only).
12. Reduce Starter → nothing lower exists with disk anyway.
13. Disable SSE or payment paths for “savings”.

---

## 7. Estimated monthly savings

| Change | Est. savings | Confidence |
|--------|--------------|------------|
| Bunny CDN (done) | **$5–40+** egress-related | High |
| API response cache (done) | **$0–15** CPU/DB indirect | Medium |
| Background health off (this step) | **$0–5** CPU (fewer probe minutes) | Medium |
| Postgres storage/tier right-size | **$5–20** | Dashboard-dependent |
| Remove extra Render service | **$7+/service** | If duplicate exists |
| API Starter → lower tier | **$0** | **Not possible** with current disk + proxy |

**Realistic safe total from Step 4 alone:** **$0–10/mo** on Render bill (mostly probe + pool tuning), plus earlier CDN/cache savings.

---

## 8. Rollout order

1. Deploy commit with health background default **off** + pool env docs.
2. Watch 48h Metrics (CPU, RAM, response times, payment success).
3. Adjust Postgres tier/storage in Dashboard if underutilized.
4. Audit **osmani-tv** service separately.
5. Revisit multi-instance / Standard tier only if RAM p95 > 80% or CPU sustained high.

---

## 9. Verification after deploy

```bash
# Logs should show:
# [SERVER_HEALTH] background probes disabled — ...

curl -s https://osmani-admin-api.onrender.com/api/health
curl -sI https://osmani-admin-api.onrender.com/api/channels  # X-Api-Cache on miss/hit in dev

# Admin: Server Health page → manual Refresh still works
# Android: streams, payments, SSE unchanged
```

---

## 10. No app rebuild

All changes are server/env only. JSON shapes unchanged.
