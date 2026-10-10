#!/usr/bin/env bash
# Called under upgrade.sh's deployment lock. Also usable locally with an explicit root.
set -Eeuo pipefail
source_root=$(readlink -f "${1:?Supply the release source directory}")
asset_root=${GREECE_DANCE_BASEMAP_ROOT:-/var/lib/greece-dance-basemaps}
[[ "$asset_root" = /* && "$asset_root" != / ]] || { echo 'Basemap root must be an absolute directory.' >&2; exit 1; }
mkdir -p "$asset_root/cache" "$asset_root/versions"
exec 8>"$asset_root/build.lock"
flock 8
version=$(python3 "$source_root/deploy/basemaps/build.py" --key)
if ! python3 "$source_root/deploy/basemaps/build.py" --check "$asset_root/versions"; then
  podman build --pull=missing --layers --file "$source_root/deploy/basemaps/Containerfile" \
    --ignorefile "$source_root/deploy/containerignore" --tag localhost/greece-dance-basemap-builder "$source_root"
  # Low CPU weight leaves the running app priority. The memory limit covers
  # Python, encoder workers, and charged filesystem cache; no swap allowance.
  podman run --rm --cpus=1 --cpu-shares=256 --memory=300m --memory-swap=300m \
    --pids-limit=64 --cap-drop=ALL --security-opt=no-new-privileges --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=32m \
    -v "$source_root:/source:ro,z" -v "$asset_root/cache:/cache:rw,z" \
    -v "$asset_root/versions:/versions:rw,z" localhost/greece-dance-basemap-builder
fi
python3 "$source_root/deploy/basemaps/build.py" --check "$asset_root/versions"
printf '%s\n' "$version" > "$source_root/.basemap-version"
