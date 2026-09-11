#!/usr/bin/env bash
# System prerequisites for Ubuntu/Debian. Only called by full setup.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run setup with sudo.' >&2; exit 1; }
command -v apt-get >/dev/null || { echo 'Automatic installation requires Ubuntu/Debian.' >&2; exit 1; }
apt-get update
apt-get install -y git curl ca-certificates nginx sudo util-linux certbot python3-certbot-nginx
if [[ ! -x /usr/bin/node ]] || [[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$installer"
  bash "$installer"
  apt-get install -y nodejs
fi
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node.js 24 installation failed.' >&2; exit 1; }
repository_root=$(dirname "$(dirname "$(readlink -f "$0")")")
cd "$repository_root"
# The password helper imports server/auth.js, which needs express-session.
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
