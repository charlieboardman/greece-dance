#!/usr/bin/env bash
# Complete deployment after setup has stored credentials. Rerunnable after failure.
set -Eeuo pipefail
umask 077
hostname=${1:?Supply the configured hostname}
enable_editor=${2:-true}
etc=${GREECE_DANCE_ETC:-/etc/greece-dance}
nginx_site=${GREECE_DANCE_NGINX:-/etc/nginx/sites-available/greece-dance}
nginx_enabled=${GREECE_DANCE_NGINX_ENABLED:-/etc/nginx/sites-enabled/greece-dance}
app_env="$etc/app.env"
[[ "$hostname" =~ ^[A-Za-z0-9.-]+$ ]] || exit 1
[[ "$enable_editor" == true || "$enable_editor" == false ]] || exit 1
set_editor() {
  # Preserve ownership and mode of the existing secret file.
  local tmp
  tmp=$(mktemp)
  sed "s/^EDITOR_ENABLED=.*/EDITOR_ENABLED=$1/" "$app_env" > "$tmp"
  cat "$tmp" > "$app_env"
  rm -f "$tmp"
}
trap 'echo "Setup stopped. Fix the reported error and rerun ./setup.sh; saved credentials will be reused." >&2' ERR
systemctl stop greece-dance-update.timer
set_editor false
echo 'Deploying the latest release and running checks. This can take a few minutes.'
echo 'To follow progress in another SSH session: journalctl -u greece-dance-update.service -f'
if ! systemctl start greece-dance-update.service; then
  echo 'Deployment failed. Check: journalctl -u greece-dance-update.service --no-pager -n 100' >&2
  echo 'Check that deploy.env points to the repository and branch containing the server and deployment code.' >&2
  exit 1
fi
# An unchanged release does not restart itself; apply settings on retries as well.
systemctl restart greece-dance.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8000/api/health |
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)'
if [[ -e "$nginx_enabled" || -L "$nginx_enabled" ]]; then
  [[ "$(readlink -f "$nginx_enabled")" == "$(readlink -f "$nginx_site")" ]] || { echo 'The enabled greece-dance Nginx site points elsewhere.' >&2; exit 1; }
else
  ln -s "$nginx_site" "$nginx_enabled"
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx
echo "Obtaining HTTPS for $hostname. DNS must point here and inbound ports 80 and 443 must be open."
# Certbot handles its own email/terms prompts and retains matching certificates.
certbot --nginx --redirect --keep-until-expiring -d "$hostname"
systemctl enable --now certbot.timer
curl --fail --silent --show-error --retry 5 --retry-delay 1 "https://$hostname/api/health" |
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)'
set_editor "$enable_editor"
if ! systemctl restart greece-dance.service; then
  set_editor false
  systemctl restart greece-dance.service || true
  exit 1
fi
if ! curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 "https://$hostname/api/health" |
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)'; then
  set_editor false
  systemctl restart greece-dance.service || true
  exit 1
fi
systemctl enable greece-dance.service
systemctl enable --now greece-dance-update.timer
echo "Map ready: https://$hostname/"
if [[ "$enable_editor" == true ]]; then echo "Editor ready: https://$hostname/editor/"; fi
