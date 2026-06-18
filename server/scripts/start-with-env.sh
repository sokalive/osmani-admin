#!/usr/bin/env bash
# PM2 entrypoint — source .env files then start Node (PM2 env_file is unreliable).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -f .env.cutover ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.cutover
  set +a
fi
exec node src/index.js
