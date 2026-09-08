#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$(readlink -f "$0")")/common.sh"
: "${DEPLOY_REPOSITORY:?Set DEPLOY_REPOSITORY to the canonical Git remote.}"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Deployment requires Node.js 24 LTS.' >&2; exit 1; }
git check-ref-format "refs/heads/$DEPLOY_BRANCH" >/dev/null
repository="$DEPLOY_ROOT/repository.git"
git init --bare "$repository" >/dev/null
git --git-dir="$repository" fetch --no-tags "$DEPLOY_REPOSITORY" "+refs/heads/$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"
revision=$(git --git-dir="$repository" rev-parse "refs/remotes/origin/$DEPLOY_BRANCH")
previous=$(readlink -f "$DEPLOY_ROOT/current" || true)
if valid_release "$previous" && [[ "$(cat "$previous/.release-sha")" == "$revision" ]]; then
  echo "Already deployed: $revision"
  exit 0
fi
staging=$(mktemp -d "$DEPLOY_ROOT/releases/.staging-XXXXXXXX")
release="$DEPLOY_ROOT/releases/$revision"
switched=false
cleanup() {
  local code=$?
  trap - EXIT
  rm -rf -- "$staging"
  if [[ "$code" != 0 && "$switched" == true ]]; then
    echo 'Deployment failed; restoring the previous release.' >&2
    if valid_release "$previous"; then
      switch_link "$previous" current
      "$DEPLOY_RESTART_HOOK" || true
      healthcheck "$(cat "$previous/.release-sha")" || echo 'Previous release restored, but its health check failed. Inspect the service.' >&2
    else
      rm -f "$DEPLOY_ROOT/current"
      echo 'No earlier release exists. Inspect the service before retrying.' >&2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
git --git-dir="$repository" archive "$revision" | tar -x -C "$staging"
(
  cd "$staging"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  npm run validate
  npm test
  npm run smoke
)
printf '%s\n' "$revision" > "$staging/.release-sha"
# mktemp creates a 0700 directory; the separate app account must be able to read it.
chmod 0755 "$staging"
if [[ -e "$release" ]]; then
  # A release with this SHA may remain from an earlier unsuccessful deployment.
  # Never overwrite a release used by current or previous.
  [[ "$(readlink -f "$DEPLOY_ROOT/previous" || true)" != "$release" ]] || { echo 'Target release is retained for rollback; use rollback.sh.' >&2; exit 1; }
  rm -rf -- "$release"
fi
mv "$staging" "$release"
switch_link "$release" current
switched=true
"$DEPLOY_RESTART_HOOK"
healthcheck "$revision"
if valid_release "$previous"; then switch_link "$previous" previous; fi
echo "Deployed: $revision"
