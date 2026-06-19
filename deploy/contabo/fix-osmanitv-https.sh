#!/usr/bin/env bash
# Fix HTTPS for api.osmanitv.com / admin.osmanitv.com / osmanitv.com on Contabo VPS.
# Does NOT touch Render production.
#
# Contabo web console one-liner:
#   curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/fix-osmanitv-https.sh | bash
#
# From repo clone:
#   CERTBOT_EMAIL=admin@osmanitv.com bash deploy/contabo/fix-osmanitv-https.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
EMAIL="${CERTBOT_EMAIL:-admin@osmanitv.com}"

diag() {
  echo "==> Diagnostics"
  echo "--- ss (80/443)"
  ss -tulpn 2>/dev/null | grep -E ':443|:80' || echo "(nothing on 80/443)"
  echo "--- nginx -t"
  nginx -t
  echo "--- systemctl status nginx"
  systemctl status nginx --no-pager -l || true
  echo "--- certbot certificates"
  certbot certificates 2>/dev/null || echo "(certbot not installed or no certs)"
  echo "--- sites-enabled"
  ls -la /etc/nginx/sites-enabled/ 2>/dev/null || true
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root on the VPS" >&2
  exit 1
fi

echo "==> Osmani TV HTTPS fix"
echo "    root: $ROOT"
echo "    email: $EMAIL"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "ERROR: $ROOT is not a git repo" >&2
  exit 1
fi

echo "==> git pull"
cd "$ROOT"
git fetch origin main
git reset --hard origin/main
echo "    commit: $(git rev-parse HEAD)"

echo "==> Firewall (ufw)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp comment 'SSH' || true
  ufw allow 80/tcp comment 'HTTP ACME' || true
  ufw allow 443/tcp comment 'HTTPS' || true
  ufw --force enable || true
  ufw status verbose || true
else
  echo "    ufw not installed — ensure Contabo panel allows 80/tcp and 443/tcp"
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets

echo "==> Install nginx snippets"
cp "$ROOT/deploy/contabo/nginx/snippets/ssl-params.conf" /etc/nginx/snippets/osmani-ssl-params.conf
cp "$ROOT/deploy/contabo/nginx/snippets/osmani-node-api.conf" /etc/nginx/snippets/osmani-node-api.conf

echo "==> Base HTTP site (IP + ACME fallback)"
cp "$ROOT/deploy/contabo/nginx-osmani-admin.conf" /etc/nginx/sites-available/osmani-admin
ln -sf /etc/nginx/sites-available/osmani-admin /etc/nginx/sites-enabled/osmani-admin
rm -f /etc/nginx/sites-enabled/default

echo "==> Phase 1: domain HTTP for ACME"
cp "$ROOT/deploy/contabo/nginx/osmanitv-acme-http.conf" /etc/nginx/sites-available/osmanitv-domains
ln -sf /etc/nginx/sites-available/osmanitv-domains /etc/nginx/sites-enabled/osmanitv-domains
nginx -t
systemctl enable nginx
systemctl restart nginx

if ! command -v certbot >/dev/null 2>&1; then
  echo "==> Installing certbot"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
fi

CERT_DIR="/etc/letsencrypt/live/osmanitv.com"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "==> Requesting Let's Encrypt certificate (webroot)"
  certbot certonly --webroot -w /var/www/certbot \
    --cert-name osmanitv.com \
    -d api.osmanitv.com -d admin.osmanitv.com -d osmanitv.com \
    --email "$EMAIL" --agree-tos --non-interactive --no-eff-email
fi

echo "==> Phase 2: HTTPS vhosts"
cp "$ROOT/deploy/contabo/nginx/osmanitv-domains.conf" /etc/nginx/sites-available/osmanitv-domains
ln -sf /etc/nginx/sites-available/osmanitv-domains /etc/nginx/sites-enabled/osmanitv-domains
nginx -t
systemctl reload nginx

echo "==> Certbot renewal timer"
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true

if [[ -f "$ROOT/deploy/contabo/patch-vps-https-env.sh" ]]; then
  echo "==> Patch VPS .env for branded HTTPS"
  bash "$ROOT/deploy/contabo/patch-vps-https-env.sh"
fi

diag

echo "==> HTTPS verification"
fail=0
health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 'https://api.osmanitv.com/api/health' || echo 000)"
root_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 'https://api.osmanitv.com/' || echo 000)"
for pair in "https://api.osmanitv.com/api/health:${health_code}" "https://api.osmanitv.com/:${root_code}"; do
  url="${pair%%:*}"
  code="${pair##*:}"
  if [[ "$code" == "200" ]]; then
    echo "    OK $url → HTTP $code"
  else
    echo "    FAIL $url → HTTP $code" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "ERROR: HTTPS verification failed" >&2
  exit 1
fi

echo "Done. HTTPS live on VPS (Render production unchanged)."
