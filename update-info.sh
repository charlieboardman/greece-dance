#!/usr/bin/env bash
set -Eeuo pipefail
exec bash "$(dirname "$(readlink -f "$0")")/deploy/update-info.sh" "$@"
