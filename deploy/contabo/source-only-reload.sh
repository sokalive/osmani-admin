#!/usr/bin/env bash
# Source-code-only Contabo reload: git reset + PM2 restart + health checks.
# Intentionally does NOT run apply-cutover, npm rebuilds, migrations, or any
# --repair / subscription-incident-recovery / data-mutation scripts.
#
#   cd /var/www/osmani-admin-api && bash deploy/contabo/source-only-reload.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
API_DIR="$ROOT/server"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "ERROR: $ROOT is not a git repo" >&2
  exit 1
fi

echo "==> SOURCE-ONLY reload (no DB mutations, no --repair, no apply-cutover)"
cd "$ROOT"
git fetch origin main
git reset --hard origin/main
COMMIT="$(git rev-parse HEAD)"
echo "    commit: $COMMIT"
export OSMANI_GIT_COMMIT="$COMMIT"
export OSMANI_ADMIN_ROOT="$ROOT"

echo "==> DATABASE_URL presence check (read-only; does not mutate data)"
node "$ROOT/deploy/contabo/sync-database-url-env.cjs" "$ROOT" >/dev/null
node -e "
const { loadContaboPm2Env } = require('$ROOT/deploy/contabo/loadPm2Env.cjs');
const e = loadContaboPm2Env('$ROOT');
if (!String(e.DATABASE_URL || '').trim()) {
  console.error('FATAL: DATABASE_URL missing');
  process.exit(1);
}
console.log('DATABASE_URL ok (' + e.DATABASE_URL.length + ' chars)');
"

echo "==> Startup smoke (loadEnv)"
(
  cd "$API_DIR"
  node -e "import('./src/loadEnv.js').then((m)=>{const ok=m.isDatabaseUrlConfigured?.()??Boolean(process.env.DATABASE_URL); if(!ok){console.error('DATABASE_URL missing after loadEnv'); process.exit(1);} console.log('loadEnv ok');}).catch((e)=>{console.error(e); process.exit(1);})"
)

echo "==> PM2 restart (API only)"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 not installed" >&2
  exit 1
fi
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
  echo "ERROR: API did not respond on :10001 within 60s" >&2
  pm2 logs osmani-admin-api --lines 40 --nostream || true
  exit 1
fi

HEALTH_JSON="$(curl -fsS "http://127.0.0.1:10001/api/health")"
echo "    API health (first probe): $HEALTH_JSON"

echo "    waiting for startup.ready=true..."
ready_ok=0
for _ in $(seq 1 45); do
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:10001/api/health" 2>/dev/null || true)"
  READY="$(printf '%s' "$HEALTH_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.startup?.ready===true))}catch{process.stdout.write('false')}})" 2>/dev/null || echo false)"
  COMMIT_NOW="$(printf '%s' "$HEALTH_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.commit||''))}catch{process.stdout.write('')}})" 2>/dev/null || true)"
  if [[ "$READY" == "true" && "$COMMIT_NOW" == "$COMMIT" ]]; then
    ready_ok=1
    break
  fi
  sleep 2
done
if [[ "$ready_ok" -ne 1 ]]; then
  echo "ERROR: startup.ready did not become true with commit $COMMIT within ~90s" >&2
  echo "    last health: $HEALTH_JSON" >&2
  pm2 logs osmani-admin-api --lines 40 --nostream || true
  exit 1
fi

echo "$HEALTH_JSON" | node -e "
const fs=require('fs');
const h=JSON.parse(fs.readFileSync(0,'utf8'));
const expect='$COMMIT';
if (String(h.commit||'') !== expect) {
  console.error('commit mismatch', h.commit, 'expected', expect);
  process.exit(1);
}
if (h.ok !== true) {
  console.error('health.ok is not true', h);
  process.exit(1);
}
if (h.startup?.ready !== true) {
  console.error('startup.ready is not true', h.startup);
  process.exit(1);
}
if (h.startup?.render === true || h.render === true) {
  console.error('render must be false on Contabo', h.startup || h);
  process.exit(1);
}
console.log('commit match', String(h.commit).slice(0,12), 'startup.ready', h.startup?.ready, 'render', h.startup?.render ?? h.render ?? false);
"
echo "==> source-only-reload complete (PostgreSQL not modified by this script)"

