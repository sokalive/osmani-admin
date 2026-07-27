#!/usr/bin/env bash
# Build & publish Osmani TV Web SPA to https://osmanitv.com on Contabo.
# Does NOT touch admin SPA or Node API process beyond nginx reload.
#
#   bash deploy/contabo/deploy-osmanitv-web.sh
set -euo pipefail

WEB_REPO="${OSMANI_TV_WEB_REPO:-https://github.com/sokalive/osmani-tv.git}"
WEB_SRC="${OSMANI_TV_WEB_SRC:-/var/www/osmani-tv}"
WEB_ROOT="${OSMANI_TV_WEB_ROOT:-/var/www/osmanitv.com}"
ADMIN_ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
BRANCH="${OSMANI_TV_WEB_BRANCH:-main}"

echo "==> Osmani TV Web deploy"
echo "    src:  $WEB_SRC"
echo "    root: $WEB_ROOT"

if [[ ! -d "$WEB_SRC/.git" ]]; then
  echo "==> clone $WEB_REPO"
  mkdir -p "$(dirname "$WEB_SRC")"
  git clone --depth 1 --branch "$BRANCH" "$WEB_REPO" "$WEB_SRC"
else
  echo "==> pull $BRANCH"
  cd "$WEB_SRC"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

cd "$WEB_SRC"
COMMIT="$(git rev-parse HEAD)"
echo "    commit: $COMMIT"

cd "$WEB_SRC/web"
if [[ ! -f package.json ]]; then
  echo "ERROR: $WEB_SRC/web/package.json missing" >&2
  exit 1
fi

echo "==> npm ci + build"
npm ci
npm run build

if [[ ! -f dist/index.html ]]; then
  echo "ERROR: dist/index.html missing after build" >&2
  exit 1
fi

echo "==> publish to $WEB_ROOT"
mkdir -p "$WEB_ROOT" "${WEB_ROOT}-prev"
if [[ -f "$WEB_ROOT/index.html" ]]; then
  rm -rf "${WEB_ROOT}-prev"
  cp -a "$WEB_ROOT" "${WEB_ROOT}-prev"
fi
rsync -a --delete "$WEB_SRC/web/dist/" "$WEB_ROOT/"

# Stamp commit for verification
printf '%s\n' "$COMMIT" > "$WEB_ROOT/.deploy-commit"

echo "==> apply nginx vhosts (api/admin/web)"
if [[ -f "$ADMIN_ROOT/deploy/contabo/reload-osmanitv-nginx.sh" ]]; then
  bash "$ADMIN_ROOT/deploy/contabo/reload-osmanitv-nginx.sh"
else
  nginx -t
  systemctl reload nginx
fi

echo "==> smoke"
curl -fsSI "https://osmanitv.com/" | head -5
curl -fsS "https://osmanitv.com/" | head -c 200; echo
curl -fsS "https://api.osmanitv.com/api/health" | head -c 180; echo
curl -fsSI "https://admin.osmanitv.com/" | head -1

echo "==> done — https://osmanitv.com commit=$COMMIT"
