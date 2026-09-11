#!/usr/bin/env bash
# Install Podman Compose service definitions; setup handles launch and HTTPS.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run this installation script as root.' >&2; exit 1; }
for command in podman podman-compose python3 git curl flock nginx; do command -v "$command" >/dev/null || { echo "Install $command first." >&2; exit 1; }; done
source_directory=$(dirname "$(readlink -f "$0")")
# Do not replace deployment scripts while the old updater is using them.
if systemctl cat greece-dance-update.timer >/dev/null 2>&1; then
  systemctl stop greece-dance-update.timer
fi
if systemctl is-active --quiet greece-dance-update.service; then
  echo 'Waiting for the current deployment to finish before installing service definitions.'
  while systemctl is-active --quiet greece-dance-update.service; do sleep 1; done
fi
id greece-dance >/dev/null 2>&1 || useradd --system --home-dir /var/lib/greece-dance-editor --shell /usr/sbin/nologin greece-dance
id greece-deploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/greece-deploy --shell /usr/sbin/nologin greece-deploy
install -d -m 0755 -o greece-deploy -g greece-deploy /srv/greece-dance /srv/greece-dance/releases
install -d -m 0700 -o greece-dance -g greece-dance /var/lib/greece-dance-editor
install -d -m 0750 -o root -g greece-dance /etc/greece-dance
# Deployment config is separate from app secrets and readable by the deploy account.
install -d -m 0755 /usr/local/lib/greece-dance/deploy /usr/local/libexec
for file in common.sh upgrade.sh rollback.sh runtime.sh; do install -m 0755 "$source_directory/$file" /usr/local/lib/greece-dance/deploy/; done
install -m 0755 "$source_directory/restart.sh" /usr/local/libexec/greece-dance-restart
for file in Containerfile containerignore compose.yaml; do install -m 0644 "$source_directory/$file" /usr/local/lib/greece-dance/deploy/; done
for file in greece-dance.service greece-dance-update.service greece-dance-update.timer; do install -m 0644 "$source_directory/$file" /etc/systemd/system/; done
if [[ ! -f /etc/greece-dance/app.env ]]; then install -m 0640 -o root -g greece-dance "$source_directory/app.env.example" /etc/greece-dance/app.env; fi
if [[ ! -f /etc/greece-dance/deploy.env ]]; then install -m 0644 "$source_directory/deploy.env.example" /etc/greece-dance/deploy.env; fi
# Permit traversal to the non-secret deploy.env without exposing app.env or the private key.
chmod 0755 /etc/greece-dance
# Builds and Compose use root's Podman storage; the app still runs as greece-dance.
# Keep the deployment Git account and its read-only SSH credentials for fetching.
chown root:root /srv/greece-dance /srv/greece-dance/releases
rm -f /etc/sudoers.d/greece-dance-deploy
if [[ ! -f /etc/nginx/sites-available/greece-dance ]]; then install -m 0644 "$source_directory/nginx.conf" /etc/nginx/sites-available/greece-dance; fi
systemctl daemon-reload
echo 'Podman Compose service definitions installed. Full setup will now configure credentials, deployment and HTTPS.'
