#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$(readlink -f "$0")")/common.sh"
current=$(readlink -f "$DEPLOY_ROOT/current" || true)
previous=$(readlink -f "$DEPLOY_ROOT/previous" || true)
valid_release "$previous" || { echo 'No previous release is available.' >&2; exit 1; }
switch_link "$previous" current
if "$DEPLOY_RESTART_HOOK" && healthcheck "$(cat "$previous/.release-sha")"; then
  if valid_release "$current"; then switch_link "$current" previous; fi
  echo "Rolled back to $(cat "$previous/.release-sha")"
else
  echo 'Rollback health check failed; restoring current.' >&2
  if valid_release "$current"; then switch_link "$current" current; "$DEPLOY_RESTART_HOOK" || true; fi
  exit 1
fi
