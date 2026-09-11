#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$(readlink -f "$0")")/common.sh"
: "${DEPLOY_REPOSITORY:?Set DEPLOY_REPOSITORY to the canonical Git remote.}"
script_directory=$(dirname "$(readlink -f "$0")")
git check-ref-format "refs/heads/$DEPLOY_BRANCH" >/dev/null
repository="$DEPLOY_ROOT/repository.git"
# Retain the existing read-only Git SSH identity without giving it Podman access.
repo_git() {
  if [[ "$EUID" == 0 ]] && id greece-deploy >/dev/null 2>&1; then
    runuser -u greece-deploy -- git "$@"
  else git "$@"; fi
}
if [[ "$EUID" == 0 ]] && id greece-deploy >/dev/null 2>&1; then
  install -d -m 0755 -o greece-deploy -g greece-deploy "$repository"
fi
repo_git init --bare "$repository" >/dev/null
repo_git --git-dir="$repository" fetch --no-tags "$DEPLOY_REPOSITORY" "+refs/heads/$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"
revision=$(repo_git --git-dir="$repository" rev-parse "refs/remotes/origin/$DEPLOY_BRANCH")
previous=$(readlink -f "$DEPLOY_ROOT/current" || true)
if valid_release "$previous" && [[ -f "$previous/.container-image" && "$(cat "$previous/.release-sha")" == "$revision" ]] && podman image exists "$(cat "$previous/.container-image")"; then
  echo "Already deployed: $revision"
  exit 0
fi
staging=$(mktemp -d "$DEPLOY_ROOT/releases/.staging-XXXXXXXX")
release="$DEPLOY_ROOT/releases/podman-$revision"
switched=false
cleanup() {
  local code=$?
  trap - EXIT
  rm -rf -- "$staging"
  if [[ -n "${legacy_staging:-}" ]]; then rm -rf -- "$legacy_staging"; fi
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
build_image() {
  local context=$1 sha=$2 output=$3
  podman build --pull=missing --file "$script_directory/Containerfile" \
    --ignorefile "$script_directory/containerignore" \
    --build-arg "RELEASE_SHA=$sha" --iidfile "$output" "$context"
  [[ "$(cat "$output")" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Build did not produce a valid image ID.' >&2; return 1; }
}
repo_git --git-dir="$repository" archive "$revision" | tar -x -C "$staging"
build_image "$staging" "$revision" "$staging/.container-image"
# Convert a retained host-Node release to an image before switching, so rollback
# also works after migration. Never write into the existing live release.
if valid_release "$previous" && [[ ! -f "$previous/.container-image" ]]; then
  legacy_sha=$(cat "$previous/.release-sha")
  legacy="$DEPLOY_ROOT/releases/legacy-container-$legacy_sha"
  legacy_staging=$(mktemp -d "$DEPLOY_ROOT/releases/.legacy-XXXXXXXX")
  if ! build_image "$previous" "$legacy_sha" "$legacy_staging/.container-image"; then
    rm -rf "$legacy_staging"
    exit 1
  fi
  printf '%s\n' "$legacy_sha" > "$legacy_staging/.release-sha"
  chmod 0755 "$legacy_staging"
  if [[ -e "$legacy" ]]; then rm -rf "$legacy_staging"; else mv "$legacy_staging" "$legacy"; fi
  previous="$legacy"
fi
printf '%s\n' "$revision" > "$staging/.release-sha"
# mktemp creates a 0700 directory; the separate app account must be able to read it.
chmod 0755 "$staging"
if [[ -e "$release" ]]; then
  # A release with this SHA may remain from an earlier unsuccessful deployment.
  # Never overwrite a release used by current or previous.
  [[ "$(readlink -f "$DEPLOY_ROOT/current" || true)" != "$release" && "$(readlink -f "$DEPLOY_ROOT/previous" || true)" != "$release" ]] || { echo 'Target release is retained for rollback; use rollback.sh.' >&2; exit 1; }
  rm -rf -- "$release"
fi
mv "$staging" "$release"
switch_link "$release" current
switched=true
"$DEPLOY_RESTART_HOOK"
healthcheck "$revision"
if valid_release "$previous"; then switch_link "$previous" previous; fi
echo "Deployed: $revision"
