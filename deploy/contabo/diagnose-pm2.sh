#!/usr/bin/env bash
# Capture PM2 + Node startup diagnostics on Contabo VPS.
#   bash deploy/contabo/diagnose-pm2.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
API_DIR="$ROOT/server"

echo "=== PM2 list ==="
pm2 list || true

echo ""
echo "=== PM2 describe osmani-admin-api ==="
pm2 describe osmani-admin-api 2>/dev/null || true

echo ""
echo "=== PM2 logs (last 80 lines) ==="
pm2 logs osmani-admin-api --lines 80 --nostream 2>/dev/null || true

echo ""
echo "=== Node loadEnv smoke test ==="
cd "$API_DIR"
node -e "
import('./src/loadEnv.js')
  .then((m) => {
    console.log('loaded:', m.getLoadedEnvPaths());
    console.log('BUNNY:', process.env.BUNNY_CDN_BASE_URL);
    console.log('ADMIN:', Boolean(process.env.ADMIN_API_TOKEN));
    return import('./src/index.js');
  })
  .then(() => console.log('index import ok'))
  .catch((e) => {
    console.error('STARTUP FAILED:', e);
    process.exit(1);
  });
" &
pid=$!
sleep 4
kill $pid 2>/dev/null || true
wait $pid 2>/dev/null || true

echo ""
echo "=== curl :10001/api/health ==="
curl -sv "http://127.0.0.1:10001/api/health" 2>&1 | tail -20
