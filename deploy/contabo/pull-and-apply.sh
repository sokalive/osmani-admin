#!/usr/bin/env bash
# Pull latest main and run full Contabo cutover (run on VPS as root).
#
# Contabo web console one-liner:
#   curl -fsSL https://raw.githubusercontent.com/sokalive/osmani-admin/main/deploy/contabo/pull-and-apply.sh | bash
#
# Or from an existing clone:
#   cd /var/www/osmani-admin-api && bash deploy/contabo/pull-and-apply.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "ERROR: $ROOT is not a git repo. Clone first:" >&2
  echo "  git clone https://github.com/sokalive/osmani-admin.git $ROOT" >&2
  exit 1
fi

echo "==> git pull (hard reset to origin/main)"
cd "$ROOT"
git fetch origin main
git reset --hard origin/main
echo "    commit: $(git rev-parse HEAD)"

export OSMANI_ADMIN_ROOT="$ROOT"
bash "$ROOT/deploy/contabo/apply-cutover.sh"

echo "==> Final migration audit"
node "$ROOT/deploy/contabo/verify-final-migration-audit.mjs"
