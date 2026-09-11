#!/usr/bin/env bash
# Operator entry point. See deploy/setup.sh.
set -Eeuo pipefail
exec bash "$(dirname "$(readlink -f "$0")")/deploy/setup.sh" "$@"
