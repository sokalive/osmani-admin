#!/usr/bin/env bash
# Apply Contabo cutover on the VPS.
#   cd /var/www/osmani-admin-api && git pull origin main && bash deploy/contabo/apply-cutover.sh
#
# If DATABASE_URL errors: node deploy/contabo/sync-database-url-env.cjs
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

upsert_env_key() {
  local key="$1"
  local val="$2"
  if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    echo "    ~ updated ${key}"
  else
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
ensure_env_key OSMANI_LOAD_CUTOVER_ENV "1"
ensure_env_key UPLOAD_DIR "/var/www/osmani-admin-api/server/uploads"
ensure_env_key NOTIFICATION_IMAGE_PUBLIC_ORIGIN "https://api.osmanitv.com"
ensure_env_key INSTRUCTION_VIDEO_PUBLIC_ORIGIN "https://api.osmanitv.com"
upsert_env_key BEEM_SENDER_NAME "OSMANITVMAX"

if [[ -f /etc/letsencrypt/live/osmanitv.com/fullchain.pem ]] || [[ "${OSMANI_USE_BRANDED_HTTPS:-}" == "1" ]]; then
  echo "==> Branded HTTPS public URLs"
  upsert_env_key BASE_URL "https://api.osmanitv.com"
  upsert_env_key STREAM_API_BASE_URL "https://api.osmanitv.com"
  upsert_env_key ADMIN_PUBLIC_URL "https://admin.osmanitv.com"
else
  ensure_env_key BASE_URL "http://144.91.117.90"
  ensure_env_key STREAM_API_BASE_URL "http://144.91.117.90"
fi

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
  echo "==> DATABASE_URL discovery (Node — avoids bash source breaking on special chars)"
  node "$ROOT/deploy/contabo/sync-database-url-env.cjs" "$ROOT"

  DATABASE_URL="$(node -e "
const { loadContaboPm2Env } = require('$ROOT/deploy/contabo/loadPm2Env.cjs');
process.stdout.write(String(loadContaboPm2Env('$ROOT').DATABASE_URL || ''));
")"

  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: DATABASE_URL is not set." >&2
    echo "Add Vultr PostgreSQL URL to $ENV_FILE (see deploy/contabo/env.production.example)" >&2
    exit 1
  fi
  export DATABASE_URL
  echo "    DATABASE_URL present (${#DATABASE_URL} chars)"
}

ensure_database_url
export DATABASE_URL

GIT_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
export OSMANI_GIT_COMMIT="$GIT_COMMIT"
export OSMANI_ADMIN_ROOT="$ROOT"
echo "    git commit: $GIT_COMMIT"

echo "==> PM2 env preload (from disk)"
node -e "
const { loadContaboPm2Env } = require('$ROOT/deploy/contabo/loadPm2Env.cjs');
const e = loadContaboPm2Env('$ROOT');
if (!String(e.DATABASE_URL || '').trim()) {
  console.error('FATAL: DATABASE_URL not found in server/.env or repo .env');
  process.exit(1);
}
console.log('DATABASE_URL ok (' + e.DATABASE_URL.length + ' chars)');
console.log('BUNNY_CDN_BASE_URL', e.BUNNY_CDN_BASE_URL || '(unset)');
"

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
  export OSMANI_ADMIN_ROOT="$ROOT"
  if ! pm2 conf pm2-logrotate:max_size >/dev/null 2>&1; then
    echo "==> pm2-logrotate (50M retain 10, compressed)"
    pm2 install pm2-logrotate || true
  fi
  pm2 set pm2-logrotate:max_size 50M 2>/dev/null || true
  pm2 set pm2-logrotate:retain 10 2>/dev/null || true
  pm2 set pm2-logrotate:compress true 2>/dev/null || true
  pm2 set pm2-logrotate:workerInterval 3600 2>/dev/null || true
  pm2 delete osmani-admin-api 2>/dev/null || true
  pm2 start "$ROOT/deploy/contabo/ecosystem.config.cjs" --update-env
  pm2 save
  echo "    waiting for API on :10001..."
  api_ready=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:10001/api/health" >/dev/null 2>&1; then
      api_ready=1
      break
    fi
    sleep 2
  done
  if [[ "$api_ready" -ne 1 ]]; then
    echo "ERROR: API did not respond on :10001 within 60s — PM2 logs:" >&2
    pm2 logs osmani-admin-api --lines 40 --nostream || true
    exit 1
  fi
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:10001/api/health" || true)"
  echo "    API health: $HEALTH_JSON"
else
  echo "ERROR: pm2 not installed" >&2
  exit 1
fi

echo "==> Nginx"
SNIPPET_SRC="$ROOT/deploy/contabo/nginx/snippets/osmani-node-api.conf"
SNIPPET_DST="/etc/nginx/snippets/osmani-node-api.conf"
if [[ -f "$SNIPPET_SRC" ]]; then
  mkdir -p /etc/nginx/snippets
  cp "$SNIPPET_SRC" "$SNIPPET_DST"
  echo "    synced $SNIPPET_DST"
fi
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

if [[ "${OSMANI_SKIP_OSMANITV_SSL:-}" != "1" ]] && [[ -f "$ROOT/deploy/contabo/fix-osmanitv-https.sh" ]]; then
  echo "==> osmanitv.com branded TLS (VPS testing — Render unchanged)"
  CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@osmanitv.com}" bash "$ROOT/deploy/contabo/fix-osmanitv-https.sh" || {
    echo "WARN: fix-osmanitv-https.sh failed — ensure DNS A records point to this VPS and ports 80/443 are open" >&2
  }
fi

echo "==> Post-deploy checks"
sleep 3
curl -fsS "http://127.0.0.1:10001/api/runtime/cutover-status" | head -c 500 || true
echo
curl -fsS "http://127.0.0.1/api/health" | head -c 200 || true
echo

if [[ -f "$API_DIR/scripts/subscription-incident-recovery.mjs" ]]; then
  echo "==> subscription incident recovery (audit + repair)"
  (cd "$API_DIR" && node scripts/subscription-incident-recovery.mjs) || {
    echo "WARN: subscription incident recovery reported unresolved users — check audit output" >&2
  }
elif [[ -f "$API_DIR/scripts/run-subscription-repair.mjs" ]]; then
  echo "==> subscription restoration repair"
  (cd "$API_DIR" && node scripts/run-subscription-repair.mjs) || {
    echo "WARN: subscription repair reported unresolved users — check audit output" >&2
  }
fi

if [[ -f "$ROOT/deploy/contabo/verify-admin-vps.mjs" ]]; then
  node "$ROOT/deploy/contabo/verify-admin-vps.mjs" || {
    echo "WARN: verify-admin-vps failed — check admin SPA build" >&2
  }
fi
if [[ -f "$API_DIR/scripts/verify-vps-render-independence.mjs" ]]; then
  echo "==> verify-vps-render-independence.mjs"
  BASE_URL="${BASE_URL:-https://api.osmanitv.com}" node "$API_DIR/scripts/verify-vps-render-independence.mjs" || {
    echo "ERROR: verify-vps-render-independence failed" >&2
    exit 1
  }
fi
if [[ -f "$API_DIR/scripts/test-payment-recovery-db-integration.mjs" ]]; then
  echo "==> test-payment-recovery-db-integration.mjs (isolated fixtures)"
  (cd "$API_DIR" && node scripts/test-payment-recovery-db-integration.mjs) || {
    echo "ERROR: payment recovery DB integration tests failed" >&2
    exit 1
  }
fi
for script in verify-cutover.mjs verify-final-migration-audit.mjs; do
  if [[ -f "$ROOT/deploy/contabo/$script" ]]; then
    echo "==> Waiting for API pool to settle before $script"
    settle_ok=0
    for _ in $(seq 1 45); do
      POOL_JSON="$(curl -fsS "http://127.0.0.1:10001/api/health" 2>/dev/null || true)"
      WAITING="$(printf '%s' "$POOL_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.pool?.waitingCount??-1))}catch{process.stdout.write('-1')}})" 2>/dev/null || echo -1)"
      if [[ "$WAITING" == "0" ]]; then
        settle_ok=1
        echo "    pool.waitingCount=0"
        break
      fi
      sleep 2
    done
    if [[ "$settle_ok" -ne 1 ]]; then
      echo "WARN: pool did not settle to waitingCount=0 before $script (last=$WAITING)" >&2
    fi
    echo "==> $script"
    EXPECT_VPS_COMMIT="$GIT_COMMIT" GITHUB_SHA="$GIT_COMMIT" node "$ROOT/deploy/contabo/$script" || {
      echo "ERROR: $script failed" >&2
      exit 1
    }
  else
    echo "ERROR: missing $ROOT/deploy/contabo/$script — run: git fetch origin main && git reset --hard origin/main" >&2
    exit 1
  fi
done
echo "Done. All verification scripts passed."
