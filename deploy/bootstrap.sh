#!/usr/bin/env bash
# System prerequisites for Ubuntu/Debian. Only called by full setup.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run setup with sudo.' >&2; exit 1; }
command -v apt-get >/dev/null || { echo 'Automatic installation requires Ubuntu/Debian.' >&2; exit 1; }
apt-get update
apt-get install -y podman podman-compose git curl ca-certificates nginx sudo util-linux python3 certbot python3-certbot-nginx
podman pull docker.io/library/node:24-bookworm-slim
