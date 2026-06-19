# VPS domain migration (osmanitv.com) — testing only

Migrate **branded HTTPS hosts** on Contabo while **Render API** (`osmani-admin-api.onrender.com`) remains production for legacy APK users.

## DNS (A records → `144.91.117.90`)

| Host | Purpose |
|------|---------|
| `api.osmanitv.com` | Node API (HTTPS) — **testing only** until APK cutover approved |
| `admin.osmanitv.com` | Admin SPA + `/api` proxy |
| `osmanitv.com` | Public landing page |

**Do not** change legacy APK `API_BASE` to VPS until explicit cutover approval.

## Nginx

| File | Role |
|------|------|
| `deploy/contabo/nginx/osmanitv-domains.conf` | HTTPS vhosts + HTTP→HTTPS redirect |
| `deploy/contabo/nginx/osmanitv-acme-http.conf` | ACME webroot (pre-cert) |
| `deploy/contabo/nginx/snippets/osmani-node-api.conf` | Shared API proxy |
| `deploy/contabo/nginx-osmani-admin.conf` | IP `144.91.117.90` HTTP (unchanged) |

## TLS (Let's Encrypt)

On VPS as root (after DNS propagates):

```bash
cd /var/www/osmani-admin-api
git pull origin main
CERTBOT_EMAIL=admin@osmanitv.com bash deploy/contabo/setup-osmanitv-ssl.sh
```

Or full cutover + SSL:

```bash
OSMANI_SETUP_OSMANITV_SSL=1 bash deploy/contabo/apply-cutover.sh
```

## Verify

```bash
curl -fsS https://api.osmanitv.com/api/health
curl -fsSI https://admin.osmanitv.com | head
curl -fsS https://osmanitv.com | head

node deploy/contabo/verify-osmanitv-domains.mjs
```

Render safety (unchanged):

```bash
curl -fsS https://osmani-admin-api.onrender.com/api/health
```

## Google Play / HTTPS

- Legacy APK continues using **Render HTTPS** — no cutover.
- VPS branded API uses **TLS only** (port 443); HTTP redirects to HTTPS.
- Express `trust proxy` enabled so `BASE_URL` and webhooks resolve HTTPS behind nginx.

## What stays on Render

| Service | Status |
|---------|--------|
| `osmani-admin-api` | **Keep live** |
| `osmani-admin-mpya` | Optional suspend after VPS admin verified |
