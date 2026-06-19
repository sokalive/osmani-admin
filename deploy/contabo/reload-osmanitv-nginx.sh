#!/usr/bin/env bash
# Apply osmanitv.com nginx vhosts from repo and reload (no cert changes).
# Run on VPS as root after git push updates deploy/contabo/nginx/*.
#
#   curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/reload-osmanitv-nginx.sh | bash
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root on the VPS" >&2
  exit 1
fi

cd "$ROOT"
git fetch origin main
git reset --hard origin/main
echo "commit: $(git rev-parse HEAD)"

mkdir -p /etc/nginx/snippets
cp "$ROOT/deploy/contabo/nginx/snippets/ssl-params.conf" /etc/nginx/snippets/osmani-ssl-params.conf
cp "$ROOT/deploy/contabo/nginx/snippets/osmani-node-api.conf" /etc/nginx/snippets/osmani-node-api.conf
cp "$ROOT/deploy/contabo/nginx/osmanitv-domains.conf" /etc/nginx/sites-available/osmanitv-domains
ln -sf /etc/nginx/sites-available/osmanitv-domains /etc/nginx/sites-enabled/osmanitv-domains

nginx -t
systemctl reload nginx

if [[ -f "$ROOT/deploy/contabo/patch-vps-https-env.sh" ]]; then
  echo "==> Patch VPS .env for branded HTTPS"
  bash "$ROOT/deploy/contabo/patch-vps-https-env.sh"
fi

echo "==> verify"
curl -fsSI "https://api.osmanitv.com" | head -1
curl -fsS "https://api.osmanitv.com/api/health"
echo
node "$ROOT/deploy/contabo/verify-osmanitv-domains.mjs"
node "$ROOT/deploy/contabo/verify-vps-infrastructure.mjs" || true
