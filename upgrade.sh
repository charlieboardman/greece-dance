#!/usr/bin/env bash
# Operator entry point. Uses the canonical remote configured in deploy.env.
set -Eeuo pipefail
exec bash "$(dirname "$(readlink -f "$0")")/deploy/upgrade.sh" "$@"
