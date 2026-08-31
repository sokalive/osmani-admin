#!/usr/bin/env bash
# Fetch osmani-admin (private repo) and hard-reset the working tree.
# Uses GITHUB_DEPLOY_TOKEN when set (CI / workflow_dispatch); else origin remote.
set -euo pipefail

git_fetch_and_reset() {
  local root="${1:?repo root required}"
  local ref="${2:-main}"
  cd "$root"
  if [[ -n "${GITHUB_DEPLOY_TOKEN:-}" ]]; then
    git fetch "https://x-access-token:${GITHUB_DEPLOY_TOKEN}@github.com/sokalive/osmani-admin.git" "$ref"
    git reset --hard FETCH_HEAD
  else
    if [[ "$ref" == origin/* ]]; then
      git fetch origin "${ref#origin/}"
      git reset --hard "$ref"
    else
      git fetch origin "$ref"
      git reset --hard FETCH_HEAD
    fi
  fi
}
