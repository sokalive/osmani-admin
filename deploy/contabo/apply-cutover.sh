#!/usr/bin/env bash
# Apply Contabo cutover on the VPS.
#   cd /var/www/osmani-admin-api && git pull origin main && bash deploy/contabo/apply-cutover.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
API_DIR="$ROOT/server"
ENV_FILE="$API_DIR/.env"
NGINX_SRC="$ROOT/deploy/contabo/nginx-osmani-admin.conf"
NGINX_DST="/etc/nginx/sites-available/osmani-admin"
DIST_DIR="$ROOT/dist"

echo "==> Osmani Admin Contabo cutover"
echo "    root: $ROOT"

if [[ ! -d "$API_DIR" ]]; then
  echo "ERROR: $API_DIR not found" >&2
  exit 1
fi

ensure_env_key() {
  local key="$1"
  local val="$2"
  if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "${key}=${val}" >> "$ENV_FILE"
    echo "    + added ${key} to .env"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "WARN: creating $ENV_FILE — set DATABASE_URL before production use"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Non-secrets are also in server/.env.cutover (git); patch .env for legacy installs.
ensure_env_key BUNNY_CDN_BASE_URL "https://osmanitv.b-cdn.net"
ensure_env_key BASE_URL "http://144.91.117.90"
ensure_env_key STREAM_API_BASE_URL "http://144.91.117.90"
ensure_env_key OSMANI_LOAD_CUTOVER_ENV "1"
ensure_env_key UPLOAD_DIR "/var/www/osmani-admin-api/server/uploads"

if ! grep -q "^ADMIN_API_TOKEN=" "$ENV_FILE" 2>/dev/null; then
  tok="${ADMIN_API_TOKEN:-${APP_UPDATE_ADMIN_TOKEN:-3030}}"
  echo "ADMIN_API_TOKEN=${tok}" >> "$ENV_FILE"
  echo "    + added ADMIN_API_TOKEN to .env"
fi
if ! grep -q "^APP_UPDATE_ADMIN_TOKEN=" "$ENV_FILE" 2>/dev/null; then
  tok="$(grep '^ADMIN_API_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  echo "APP_UPDATE_ADMIN_TOKEN=${tok}" >> "$ENV_FILE"
  echo "    + added APP_UPDATE_ADMIN_TOKEN to .env"
fi

source_env_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
    echo "    sourced $(basename "$f") from $f"
  fi
}

ensure_database_url() {
  source_env_file "$ENV_FILE"
  source_env_file "$ROOT/.env"
  source_env_file "$API_DIR/.env.local"
  source_env_file "$ROOT/.env.local"

  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "    DATABASE_URL present (${#DATABASE_URL} chars)"
    return 0
  fi

  echo "==> DATABASE_URL missing — searching legacy locations"
  local found=""
  for f in "$ENV_FILE" "$ROOT/.env" "$API_DIR/.env.backup" "$ROOT/.env.backup" /root/.osmani-admin.env; do
    if [[ -f "$f" ]] && grep -qE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' "$f"; then
      found="$(grep -E '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' "$f" | head -1 | sed 's/^[[:space:]]*export[[:space:]]*//')"
      echo "    found in $f"
      break
    fi
  done

  if [[ -n "$found" ]]; then
    if ! grep -qE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' "$ENV_FILE" 2>/dev/null; then
      echo "$found" >> "$ENV_FILE"
      echo "    + copied DATABASE_URL into $ENV_FILE"
    fi
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi

  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: DATABASE_URL is not set." >&2
    echo "Add Vultr PostgreSQL URL to $ENV_FILE (see deploy/contabo/env.production.example)" >&2
    exit 1
  fi
}

ensure_database_url
export DATABASE_URL

echo "==> Admin SPA build (same-origin /api)"
cd "$ROOT"
npm ci
VITE_API_BASE_URL= npm run build
mkdir -p "$DIST_DIR"
rsync -a --delete dist/ "$DIST_DIR/" 2>/dev/null || cp -a dist/. "$DIST_DIR/"

echo "==> API dependencies"
cd "$API_DIR"
npm ci

echo "==> Startup smoke test"
node -e "import('./src/loadEnv.js').then((m)=>{const ok=m.isDatabaseUrlConfigured?.()??Boolean(process.env.DATABASE_URL); if(!ok){console.error('DATABASE_URL missing after loadEnv'); process.exit(1);} console.log('loadEnv ok', m.getLoadedEnvPaths(), 'db', ok, 'bunny', process.env.BUNNY_CDN_BASE_URL);}).catch((e)=>{console.error(e); process.exit(1);})"

echo "==> PM2 restart"
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete osmani-admin-api 2>/dev/null || true
  pm2 start "$ROOT/deploy/contabo/ecosystem.config.cjs" --update-env
  pm2 save
  sleep 3
  if ! curl -fsS "http://127.0.0.1:10001/api/health" >/dev/null; then
    echo "ERROR: API did not respond on :10001 — PM2 logs:" >&2
    pm2 logs osmani-admin-api --lines 30 --nostream || true
    exit 1
  fi
else
  echo "ERROR: pm2 not installed" >&2
  exit 1
fi

echo "==> Nginx"
if [[ -f "$NGINX_SRC" ]]; then
  cp "$NGINX_SRC" "$NGINX_DST"
  ln -sf "$NGINX_DST" /etc/nginx/sites-enabled/osmani-admin
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl reload nginx
else
  echo "ERROR: nginx config missing at $NGINX_SRC" >&2
  exit 1
fi

echo "==> Post-deploy checks"
sleep 3
curl -fsS "http://127.0.0.1:10001/api/runtime/cutover-status" | head -c 500 || true
echo
curl -fsS "http://127.0.0.1/api/health" | head -c 200 || true
echo
echo "Done. Run: node $ROOT/deploy/contabo/verify-cutover.mjs"
