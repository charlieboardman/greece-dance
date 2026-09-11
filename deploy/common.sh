#!/usr/bin/env bash
# Sourced by installed update/rollback scripts. Configuration is administrator-owned.
set -Eeuo pipefail
if [[ -f "${DEPLOY_CONFIG:-/etc/greece-dance/deploy.env}" ]]; then
  source "${DEPLOY_CONFIG:-/etc/greece-dance/deploy.env}"
fi
: "${DEPLOY_ROOT:=/srv/greece-dance}"
: "${DEPLOY_BRANCH:=main}"
: "${DEPLOY_HEALTH_URL:=http://127.0.0.1:8000/api/health}"
: "${DEPLOY_RESTART_HOOK:=/usr/local/libexec/greece-dance-restart}"
: "${DEPLOY_HEALTH_ATTEMPTS:=20}"
[[ "$DEPLOY_ROOT" = /* && "$DEPLOY_ROOT" != / ]] || { echo 'DEPLOY_ROOT must be an absolute application directory.' >&2; exit 1; }
[[ -x "$DEPLOY_RESTART_HOOK" ]] || { echo 'A restart hook is required.' >&2; exit 1; }
mkdir -p "$DEPLOY_ROOT/releases"
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -n 9 || { echo 'Another deployment is running; skipping.'; exit 0; }

switch_link() {
  local target="$1" name="$2"
  ln -s "$target" "$DEPLOY_ROOT/.$name-$$"
  mv -Tf "$DEPLOY_ROOT/.$name-$$" "$DEPLOY_ROOT/$name"
}

healthcheck() {
  local expected="$1" response attempt
  for ((attempt=0; attempt<DEPLOY_HEALTH_ATTEMPTS; attempt++)); do
    if response=$(curl --silent --show-error --fail --max-time 2 "$DEPLOY_HEALTH_URL" 2>/dev/null) &&
      printf '%s' "$response" | python3 -c '
import json,sys
try:
    value=json.load(sys.stdin)
    sys.exit(0 if value.get("ok") is True and value.get("revision") == sys.argv[1] else 1)
except (ValueError, AttributeError):
    sys.exit(1)
      ' "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}

valid_release() {
  local candidate="$1"
  [[ "$candidate" == "$DEPLOY_ROOT/releases/"* && -d "$candidate" && -f "$candidate/.release-sha" ]]
}
