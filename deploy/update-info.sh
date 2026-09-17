#!/usr/bin/env bash
# Run the same Node publisher as the editor, with the same mounts and service UID.
set -Eeuo pipefail
script_directory=$(dirname "$(readlink -f "$0")")
exec bash "$script_directory/runtime.sh" run --rm --no-deps app \
  node --env-file=/etc/greece-dance/app.env server/update-info.js
