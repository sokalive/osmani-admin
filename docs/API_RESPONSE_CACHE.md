# API response cache (Phase 3 Step 3)

Lightweight **in-memory** cache on the Node API for identical public `GET` requests. Reduces PostgreSQL reads and JSON serialization CPU. Does not change response JSON shapes.

## Cached endpoints

| Endpoint | TTL (default) | Invalidates on |
|----------|---------------|----------------|
| `GET /api/channels` | 20s | channel admin writes |
| `GET /api/banners` | 20s | banner admin writes |
| `GET /api/plans` | 60s | plan admin writes |
| `GET /api/payment-providers` | 60s | provider admin writes |
| `GET /api/whatsapp-settings` | 30s | WhatsApp settings save |
| `GET /api/settings/whatsapp` | 30s | same |
| `GET /api/settings/popup` | 30s | popup settings save |
| `GET /api/settings/public` | 30s | WhatsApp or popup save |
| `GET /api/runtime/app-modes` | 15s | global app modes save |

## Not cached

Subscription, payments, device/auth, analytics, notifications runtime, OTA/update-check, SSE (`/api/sync/stream`), admin routes, personalized responses.

## Behavior

- Concurrent identical requests share one in-flight loader (**DEDUP**).
- `liveSyncBus` admin events purge related namespaces immediately.
- Bounded size (`API_CACHE_MAX_ENTRIES`, default 48).
- Browser still receives `Cache-Control: no-store` on catalog routes; only the **server** avoids repeat DB work.
- Dev/staging: response header `X-Api-Cache: HIT | MISS | DEDUP` (omitted in production unless `API_CACHE_DEBUG=1`).

## Verify

```bash
cd server
npm run verify:api-cache
# After deploy (non-production or API_CACHE_DEBUG=1):
curl -s https://<api>/api/health | jq .api_cache
curl -sI https://<api>/api/channels | grep -i x-api-cache
```
