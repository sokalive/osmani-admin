# VPS infrastructure audit (post HTTPS migration)

Run from any machine with network access:

```bash
node deploy/contabo/verify-vps-infrastructure.mjs
node deploy/contabo/verify-osmanitv-domains.mjs
node deploy/contabo/verify-final-migration-audit.mjs
node deploy/contabo/verify-admin-vps.mjs
```

## On VPS after env patch

If `env-base-url` fails (`http://144.91.117.90` still in `.env`):

```bash
curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/patch-vps-https-env.sh | bash
```

Or full reload (nginx + env + verify):

```bash
curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/reload-osmanitv-nginx.sh | bash
```

## Google Play / HTTPS

| Requirement | VPS status |
|-------------|--------------|
| API over TLS | `https://api.osmanitv.com` (nginx TLS 1.2/1.3) |
| HTTP → HTTPS redirect | All branded hosts |
| Stream proxy URLs | `https://api.osmanitv.com/stream-proxy?...` |
| Thumbnails | `https://osmanitv.b-cdn.net/uploads/...` |
| Legacy Render APK | Unchanged — `https://osmani-admin-api.onrender.com` |

## Render (do not modify)

Legacy APK users continue on Render HTTPS API. VPS branded domains are for new APK / testing only until explicit cutover approval.
