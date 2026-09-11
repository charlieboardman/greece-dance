#!/usr/bin/env bash
# systemd manages Compose; the app uses the existing unprivileged service UID.
set -Eeuo pipefail
export GREECE_DANCE_IMAGE
GREECE_DANCE_IMAGE=$(cat /srv/greece-dance/current/.container-image)
[[ "$GREECE_DANCE_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid container image ID.' >&2; exit 1; }
export GREECE_DANCE_UID GREECE_DANCE_GID
GREECE_DANCE_UID=$(id -u greece-dance)
GREECE_DANCE_GID=$(id -g greece-dance)
export PODMAN_COMPOSE_PROVIDER=/usr/bin/podman-compose
exec podman compose --project-name greece-dance \
  --file /usr/local/lib/greece-dance/deploy/compose.yaml "$@"
