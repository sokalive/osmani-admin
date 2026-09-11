#!/usr/bin/env bash
# Upsert Admin auth secrets into Contabo server/.env WITHOUT printing secret values.
# Run on the Osmani Admin VPS only. Pass secrets via the environment (never commit them).
#
# Required env when enabling production login:
#   ADMIN_JWT_SECRET
#   ADMIN_LOGIN_PIN
#   ADMIN_SECURITY_PIN
#   ADMIN_PANEL_BOOTSTRAP_EMAIL
#   ADMIN_ALERT_EMAIL
#   RESEND_API_KEY
#   RESEND_FROM_EMAIL
#
# Optional:
#   ADMIN_PANEL_BOOTSTRAP_PASSWORD  (defaults to ADMIN_LOGIN_PIN if unset)
#   ENV_FILE                        (default: $OSMANI_ADMIN_ROOT/server/.env)
#
# Example (on VPS):
#   export ADMIN_JWT_SECRET='…'
#   export ADMIN_LOGIN_PIN='…'
#   export ADMIN_SECURITY_PIN='…'
#   export ADMIN_PANEL_BOOTSTRAP_EMAIL='…'
#   export ADMIN_ALERT_EMAIL='…'
#   export RESEND_API_KEY='…'
#   export RESEND_FROM_EMAIL='Osmani Admin <noreply@yourdomain>'
#   bash deploy/contabo/upsert-admin-auth-env.sh
set -euo pipefail

ROOT="${OSMANI_ADMIN_ROOT:-/var/www/osmani-admin-api}"
ENV_FILE="${ENV_FILE:-$ROOT/server/.env}"

upsert() {
  local key="$1"
  local val="$2"
  if [[ -z "${val}" ]]; then
    echo "SKIP  $key (empty)"
    return 0
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # portable in-place replace without echoing value
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      BEGIN { done=0 }
      index($0, k "=") == 1 { print k "=" v; done=1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
    echo "UPD   $key"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    echo "ADD   $key"
  fi
}

echo "==> Upserting admin auth env into $ENV_FILE (values not printed)"

upsert ADMIN_TRUSTED_INSTALL "${ADMIN_TRUSTED_INSTALL:-0}"
upsert ADMIN_PANEL_AUTH_REQUIRED "${ADMIN_PANEL_AUTH_REQUIRED:-true}"
upsert ADMIN_PANEL_LEGACY_TOKEN_FALLBACK "${ADMIN_PANEL_LEGACY_TOKEN_FALLBACK:-false}"
upsert ADMIN_JWT_SECRET "${ADMIN_JWT_SECRET:-}"
upsert ADMIN_LOGIN_PIN "${ADMIN_LOGIN_PIN:-}"
upsert ADMIN_SECURITY_PIN "${ADMIN_SECURITY_PIN:-}"
upsert ADMIN_PANEL_BOOTSTRAP_EMAIL "${ADMIN_PANEL_BOOTSTRAP_EMAIL:-}"
upsert ADMIN_PANEL_BOOTSTRAP_PASSWORD "${ADMIN_PANEL_BOOTSTRAP_PASSWORD:-${ADMIN_LOGIN_PIN:-}}"
upsert ADMIN_ALERT_EMAIL "${ADMIN_ALERT_EMAIL:-}"
upsert ADMIN_LOGIN_EMAILS "${ADMIN_LOGIN_EMAILS:-${ADMIN_PANEL_BOOTSTRAP_EMAIL:-}}"
upsert RESEND_API_KEY "${RESEND_API_KEY:-}"
upsert RESEND_FROM_EMAIL "${RESEND_FROM_EMAIL:-}"
# Fixed 14-day trusted-device window (non-sliding). Override only if intentionally changing policy.
upsert ADMIN_TRUSTED_DEVICE_DAYS "${ADMIN_TRUSTED_DEVICE_DAYS:-14}"
upsert ADMIN_SESSION_TTL_SECONDS "${ADMIN_SESSION_TTL_SECONDS:-1209600}"
upsert ADMIN_SESSION_COOKIE_DAYS "${ADMIN_SESSION_COOKIE_DAYS:-14}"
upsert ADMIN_DEVICE_COOKIE_DAYS "${ADMIN_DEVICE_COOKIE_DAYS:-14}"

chmod 600 "$ENV_FILE" || true
echo "==> Done. Restart PM2 (pm2 restart osmani-admin-api --update-env) after deploy."
