#!/usr/bin/env bash
# Install on the future droplet, after reviewing deploy/README.md. Does not deploy or enable the timer.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run this installation script as root.' >&2; exit 1; }
[[ -x /usr/bin/node && "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Install Node.js 24 at /usr/bin/node first.' >&2; exit 1; }
for command in npm git curl flock nginx sudo visudo; do command -v "$command" >/dev/null || { echo "Install $command first." >&2; exit 1; }; done
source_directory=$(dirname "$(readlink -f "$0")")
id greece-dance >/dev/null 2>&1 || useradd --system --home-dir /var/lib/greece-dance-editor --shell /usr/sbin/nologin greece-dance
id greece-deploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/greece-deploy --shell /usr/sbin/nologin greece-deploy
install -d -m 0755 -o greece-deploy -g greece-deploy /srv/greece-dance /srv/greece-dance/releases
install -d -m 0700 -o greece-dance -g greece-dance /var/lib/greece-dance-editor
install -d -m 0750 -o root -g greece-dance /etc/greece-dance
# Deployment config is separate from app secrets and readable by the deploy account.
install -d -m 0755 /usr/local/lib/greece-dance/deploy /usr/local/libexec
for file in common.sh update.sh rollback.sh; do install -m 0755 "$source_directory/$file" /usr/local/lib/greece-dance/deploy/; done
install -m 0755 "$source_directory/restart.sh" /usr/local/libexec/greece-dance-restart
for file in greece-dance.service greece-dance-update.service greece-dance-update.timer; do install -m 0644 "$source_directory/$file" /etc/systemd/system/; done
if [[ ! -f /etc/greece-dance/app.env ]]; then install -m 0640 -o root -g greece-dance "$source_directory/app.env.example" /etc/greece-dance/app.env; fi
if [[ ! -f /etc/greece-dance/deploy.env ]]; then install -m 0644 "$source_directory/deploy.env.example" /etc/greece-dance/deploy.env; fi
# Permit traversal to the non-secret deploy.env without exposing app.env or the private key.
chmod 0755 /etc/greece-dance
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
printf '%s\n' 'greece-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart greece-dance.service' > "$sudoers"
visudo -cf "$sudoers"
install -m 0440 "$sudoers" /etc/sudoers.d/greece-dance-deploy
if [[ ! -f /etc/nginx/sites-available/greece-dance ]]; then install -m 0644 "$source_directory/nginx.conf" /etc/nginx/sites-available/greece-dance; fi
systemctl daemon-reload
echo 'Infrastructure installed. Configure the environment and domain, then follow deploy/README.md for the first deployment and timer activation.'
