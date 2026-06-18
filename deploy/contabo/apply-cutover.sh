#!/usr/bin/env bash
# Apply Contabo cutover on the VPS (run as root or with sudo).
#   cd /var/www/osmani-admin && git pull && bash deploy/contabo/apply-cutover.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin}"
API_DIR="$ROOT/server"
ENV_FILE="$API_DIR/.env"
NGINX_SRC="$ROOT/deploy/contabo/nginx-osmani-admin.conf"
NGINX_DST="/etc/nginx/sites-available/osmani-admin"

echo "==> Osmani Admin Contabo cutover"
echo "    root: $ROOT"

if [[ ! -d "$API_DIR" ]]; then
  echo "ERROR: $API_DIR not found" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "WARN: $ENV_FILE missing — copy deploy/contabo/env.production.example and edit secrets"
fi

echo "==> Install admin SPA"
cd "$ROOT"
npm ci
# Same-origin /api — do not bake Render URL into the bundle.
VITE_API_BASE_URL= npm run build
mkdir -p /var/www/osmani-admin/dist
rsync -a --delete dist/ /var/www/osmani-admin/dist/ 2>/dev/null || cp -a dist/. /var/www/osmani-admin/dist/

echo "==> Install API dependencies"
cd "$API_DIR"
npm ci

echo "==> PM2 restart API"
if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload "$ROOT/deploy/contabo/ecosystem.config.cjs" --update-env
  pm2 save
else
  echo "WARN: pm2 not installed — start API manually on PORT=10001"
fi

echo "==> Nginx"
if [[ -f "$NGINX_SRC" ]]; then
  cp "$NGINX_SRC" "$NGINX_DST"
  ln -sf "$NGINX_DST" /etc/nginx/sites-enabled/osmani-admin
  nginx -t
  systemctl reload nginx
else
  echo "WARN: nginx config not found at $NGINX_SRC"
fi

echo "==> Verify"
sleep 2
curl -fsS "http://127.0.0.1:10001/api/health" | head -c 200 || true
echo
curl -fsS "http://127.0.0.1/api/runtime/cutover-status" | head -c 400 || true
echo
echo "Done. Run: node $ROOT/deploy/contabo/verify-cutover.mjs"
