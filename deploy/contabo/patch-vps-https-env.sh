#!/usr/bin/env bash
# Upsert branded HTTPS public URLs in VPS server/.env and restart API.
# Contabo only — does not touch Render.
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
ENV_FILE="$ROOT/server/.env"
API_URL="${OSMANI_API_URL:-https://api.osmanitv.com}"
ADMIN_URL="${OSMANI_ADMIN_URL:-https://admin.osmanitv.com}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

upsert_env() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
  echo "    ${key}=${val}"
}

echo "==> Patch VPS public URLs (HTTPS branded)"
upsert_env BASE_URL "$API_URL"
upsert_env STREAM_API_BASE_URL "$API_URL"
upsert_env ADMIN_PUBLIC_URL "$ADMIN_URL"
upsert_env OSMANI_LOAD_CUTOVER_ENV "1"

if grep -q "^ASSET_LEGACY_ORIGIN_HOSTS=" "$ENV_FILE" 2>/dev/null; then
  hosts="$(grep '^ASSET_LEGACY_ORIGIN_HOSTS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  for h in api.osmanitv.com admin.osmanitv.com; do
    if [[ "$hosts" != *"$h"* ]]; then
      hosts="${hosts},${h}"
    fi
  done
  upsert_env ASSET_LEGACY_ORIGIN_HOSTS "$hosts"
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart osmani-admin-api --update-env
  sleep 3
fi

curl -fsS "${API_URL}/api/health" | head -c 200 || true
echo
