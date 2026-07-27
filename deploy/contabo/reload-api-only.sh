#!/usr/bin/env bash
# Pull latest main and restart only the API PM2 process (no npm/admin SPA rebuild).
# Use when cutover fails on npm ENOTEMPTY but server source already needs a live reload.
#
#   cd /var/www/osmani-admin-api && bash deploy/contabo/reload-api-only.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
API_DIR="$ROOT/server"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "ERROR: $ROOT is not a git repo" >&2
  exit 1
fi

echo "==> git pull (hard reset to origin/main)"
cd "$ROOT"
git fetch origin main
git reset --hard origin/main
COMMIT="$(git rev-parse HEAD)"
echo "    commit: $COMMIT"
export OSMANI_GIT_COMMIT="$COMMIT"
export OSMANI_ADMIN_ROOT="$ROOT"

echo "==> DATABASE_URL check"
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
cd "$API_DIR"
node -e "import('./src/loadEnv.js').then((m)=>{const ok=m.isDatabaseUrlConfigured?.()??Boolean(process.env.DATABASE_URL); if(!ok){console.error('DATABASE_URL missing after loadEnv'); process.exit(1);} console.log('loadEnv ok');}).catch((e)=>{console.error(e); process.exit(1);})"

echo "==> regression-account-plan-consistency.mjs"
(cd "$API_DIR" && node scripts/regression-account-plan-consistency.mjs) || {
  echo "ERROR: account plan consistency regression failed" >&2
  exit 1
}

echo "==> regression-device-isolation.mjs"
(cd "$API_DIR" && node scripts/regression-device-isolation.mjs) || {
  echo "ERROR: device isolation regression failed" >&2
  exit 1
}

echo "==> regression-transaction-read-only-ownership.mjs"
(cd "$API_DIR" && node scripts/regression-transaction-read-only-ownership.mjs) || {
  echo "ERROR: transaction read-only ownership regression failed" >&2
  exit 1
}

echo "==> audit-device-isolation.mjs (read-only)"
# Load DATABASE_URL into this shell the same way PM2 does.
eval "$(node -e "
const { loadContaboPm2Env } = require('$ROOT/deploy/contabo/loadPm2Env.cjs');
const e = loadContaboPm2Env('$ROOT');
const u = String(e.DATABASE_URL || '').trim();
if (!u) { console.error('FATAL: DATABASE_URL missing for audit'); process.exit(1); }
process.stdout.write('export DATABASE_URL=' + JSON.stringify(u) + '\n');
")"
(cd "$API_DIR" && node scripts/audit-device-isolation.mjs) || {
  echo "ERROR: device isolation audit failed" >&2
  exit 1
}

echo "==> audit-transaction-read-only-ownership.mjs (read-only)"
(cd "$API_DIR" && node scripts/audit-transaction-read-only-ownership.mjs) || {
  echo "ERROR: transaction ownership audit failed" >&2
  exit 1
}

echo "==> audit-account-plan-consistency.mjs --repair (metadata only)"
(cd "$API_DIR" && node scripts/audit-account-plan-consistency.mjs --repair) || {
  echo "ERROR: account plan consistency audit/repair failed" >&2
  exit 1
}

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
echo "    API health: $HEALTH_JSON"
echo "$HEALTH_JSON" | node -e "
const fs=require('fs');
const h=JSON.parse(fs.readFileSync(0,'utf8'));
const expect='$COMMIT';
if (String(h.commit||'') !== expect) {
  console.error('commit mismatch', h.commit, 'expected', expect);
  process.exit(1);
}
console.log('commit match', String(h.commit).slice(0,12));
"
echo "==> reload-api-only complete"
