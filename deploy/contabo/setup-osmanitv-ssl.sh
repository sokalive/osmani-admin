#!/usr/bin/env bash
# Provision Let's Encrypt TLS for osmanitv.com branded hosts on Contabo VPS.
# Does NOT change Render production — VPS testing domains only.
#
# Prerequisites:
#   A records → 144.91.117.90 for api.osmanitv.com, admin.osmanitv.com, osmanitv.com
#
# Usage (on VPS as root):
#   CERTBOT_EMAIL=you@osmanitv.com bash deploy/contabo/setup-osmanitv-ssl.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
EMAIL="${CERTBOT_EMAIL:-admin@osmanitv.com}"
DOMAINS=(api.osmanitv.com admin.osmanitv.com osmanitv.com)
CERT_NAME="osmanitv.com"
CERT_DIR="/etc/letsencrypt/live/${CERT_NAME}"

echo "==> Osmani TV domain TLS setup"
echo "    root: $ROOT"
echo "    email: $EMAIL"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root on the VPS" >&2
  exit 1
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets

echo "==> Install nginx snippets"
cp "$ROOT/deploy/contabo/nginx/snippets/ssl-params.conf" /etc/nginx/snippets/osmani-ssl-params.conf
cp "$ROOT/deploy/contabo/nginx/snippets/osmani-node-api.conf" /etc/nginx/snippets/osmani-node-api.conf

deploy_acme_http() {
  cp "$ROOT/deploy/contabo/nginx/osmanitv-acme-http.conf" /etc/nginx/sites-available/osmanitv-domains
  ln -sf /etc/nginx/sites-available/osmanitv-domains /etc/nginx/sites-enabled/osmanitv-domains
  nginx -t
  systemctl reload nginx
}

deploy_ssl_vhosts() {
  if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
    echo "ERROR: cert missing at $CERT_DIR" >&2
    exit 1
  fi
  cp "$ROOT/deploy/contabo/nginx/osmanitv-domains.conf" /etc/nginx/sites-available/osmanitv-domains
  ln -sf /etc/nginx/sites-available/osmanitv-domains /etc/nginx/sites-enabled/osmanitv-domains
  nginx -t
  systemctl reload nginx
}

if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "==> Existing certificate found — deploying HTTPS vhosts"
  deploy_ssl_vhosts
else
  echo "==> Phase 1: HTTP ACME webroot"
  deploy_acme_http

  if ! command -v certbot >/dev/null 2>&1; then
    echo "==> Installing certbot"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
  fi

  echo "==> Requesting certificate (webroot)"
  certbot certonly --webroot -w /var/www/certbot \
    --cert-name "$CERT_NAME" \
    -d api.osmanitv.com -d admin.osmanitv.com -d osmanitv.com \
    --email "$EMAIL" --agree-tos --non-interactive --no-eff-email

  echo "==> Phase 2: HTTPS vhosts"
  deploy_ssl_vhosts
fi

echo "==> Certbot renewal timer"
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable certbot.timer 2>/dev/null || true
  systemctl start certbot.timer 2>/dev/null || true
fi

echo "==> Smoke checks"
for url in \
  "https://api.osmanitv.com/api/health" \
  "https://admin.osmanitv.com/" \
  "https://osmanitv.com/"; do
  if curl -fsS "$url" >/dev/null; then
    echo "    OK $url"
  else
    echo "    WARN failed $url" >&2
  fi
done

echo "Done. Branded HTTPS hosts are live on VPS (Render unchanged)."
