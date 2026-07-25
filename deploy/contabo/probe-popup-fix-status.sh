#!/usr/bin/env bash
set -euo pipefail
cd /var/www/osmani-admin-api
echo "=== commit ==="
git rev-parse HEAD
echo "=== pm2 ==="
pm2 jlist | node -e '
const fs=require("fs");
const raw=fs.readFileSync(0,"utf8");
const arr=JSON.parse(raw||"[]");
for (const p of arr) {
  if (!String(p.name||"").includes("osmani")) continue;
  console.log(JSON.stringify({
    name:p.name,
    status:p.pm2_env&&p.pm2_env.status,
    restarts:p.pm2_env&&p.pm2_env.restart_time,
    uptime_ms: p.pm2_env ? (Date.now()-(p.pm2_env.pm_uptime||0)) : null,
    unstable:p.pm2_env&&p.pm2_env.unstable_restarts
  }));
}
'
echo "=== recent verify-decision logs ==="
pm2 logs osmani-admin-api --lines 80 --nostream 2>/dev/null | grep -E "subscription-verify-decision|subscription-stream-decision" | tail -n 30 || true
echo "=== false-expired via local health ==="
curl -fsS http://127.0.0.1:10001/api/health | head -c 300; echo
