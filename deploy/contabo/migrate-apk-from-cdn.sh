#!/usr/bin/env bash
# Copy production OTA APK from Bunny edge cache onto Contabo disk.
# Bunny pull origin still points at suspended Render — origin misses 503; edge cache
# still serves the known APK. Contabo currently 404s the same path.
#
# Safe: only writes the file when missing or SHA mismatch; never deletes other uploads.
#
#   cd /var/www/osmani-admin-api && bash deploy/contabo/migrate-apk-from-cdn.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
# shellcheck disable=SC1091
eval "$(node -e "
const { loadContaboPm2Env } = require('$ROOT/deploy/contabo/loadPm2Env.cjs');
const e = loadContaboPm2Env('$ROOT');
const upload = String(e.UPLOAD_DIR || '$ROOT/server/uploads').trim();
process.stdout.write('export UPLOAD_DIR=' + JSON.stringify(upload) + '\n');
")"

APK_NAME="${APK_NAME:-osmani-v24-1.8.2.apk}"
EXPECT_SHA256="${EXPECT_SHA256:-b797e59092a87a2fc7a779e02748ff66c854c0820f9d0095cf1148b921407b80}"
CDN_URL="${CDN_URL:-https://osmanitv.b-cdn.net/uploads/apks/${APK_NAME}}"
DEST_DIR="${UPLOAD_DIR%/}/apks"
DEST="$DEST_DIR/$APK_NAME"

mkdir -p "$DEST_DIR"

sha_of() {
  sha256sum "$1" | awk '{print $1}'
}

if [[ -f "$DEST" ]]; then
  HAVE="$(sha_of "$DEST")"
  if [[ "$HAVE" == "$EXPECT_SHA256" ]]; then
    echo "OK: $DEST already present (sha256 match)"
    ls -lh "$DEST"
    exit 0
  fi
  echo "WARN: $DEST exists but sha256=$HAVE expected=$EXPECT_SHA256 — re-downloading"
fi

TMP="$(mktemp "$DEST_DIR/.${APK_NAME}.XXXXXX")"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "==> downloading $CDN_URL"
curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$CDN_URL"
GOT="$(sha_of "$TMP")"
if [[ "$GOT" != "$EXPECT_SHA256" ]]; then
  echo "ERROR: sha256 mismatch got=$GOT expected=$EXPECT_SHA256" >&2
  exit 1
fi

mv -f "$TMP" "$DEST"
trap - EXIT
chmod 644 "$DEST"
echo "OK: wrote $DEST ($(du -h "$DEST" | awk '{print $1}')) sha256=$GOT"
