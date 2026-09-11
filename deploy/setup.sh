#!/usr/bin/env bash
# Guided droplet installation. Browser-only GitHub App steps remain interactive.
set -Eeuo pipefail
umask 077

source_directory=$(dirname "$(readlink -f "$0")")
repository_root=$(dirname "$source_directory")
etc=${GREECE_DANCE_ETC:-/etc/greece-dance}
nginx_site=${GREECE_DANCE_NGINX:-/etc/nginx/sites-available/greece-dance}
app_env="$etc/app.env"
pem_destination="$etc/github-app.pem"
skip_install=false
force=false
enable_editor=""
hostname=""
repository=""
app_id=""
installation_id=""
pem_source=""
password_file=""

usage() {
  cat <<'EOF'
Usage: sudo ./setup.sh [options]

Install dependencies, configure credentials, deploy, obtain HTTPS, and start the
editor. Create and install the GitHub App using the printed browser instructions.

Options:
  --skip-install          Configure credentials only; skip packages, deployment and HTTPS
  --hostname NAME         Domain, sslip.io hostname, or IPv4 (converted to sslip.io)
  --repository owner/name GitHub repository (default from app.env)
  --app-id ID             GitHub App ID
  --installation-id ID    Installation ID from the install URL
  --pem PATH              Downloaded GitHub App private key
  --password-file PATH    Editor password (otherwise prompt)
  --enable-editor         Enable editor (default for full setup; requires HTTPS)
  --disable-editor        Leave or set EDITOR_ENABLED=false
  --force                 Replace an existing github-app.pem
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) skip_install=true; shift ;;
    --hostname) hostname=$2; shift 2 ;;
    --repository) repository=$2; shift 2 ;;
    --app-id) app_id=$2; shift 2 ;;
    --installation-id) installation_id=$2; shift 2 ;;
    --pem) pem_source=$2; shift 2 ;;
    --password-file) password_file=$2; shift 2 ;;
    --enable-editor) enable_editor=true; shift ;;
    --disable-editor) enable_editor=false; shift ;;
    --force) force=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$etc" == /etc/greece-dance && "$EUID" != 0 ]]; then
  echo 'Run as root: sudo ./setup.sh' >&2
  exit 1
fi

if [[ "$skip_install" == false ]]; then
  bash "$source_directory/bootstrap.sh"
fi

node_bin=${NODE:-}
if [[ -z "$node_bin" ]]; then
  if [[ -x /usr/bin/node ]]; then node_bin=/usr/bin/node
  else node_bin=$(command -v node); fi
fi
[[ -n "$node_bin" ]] || { echo 'Node.js is required to hash the editor password.' >&2; exit 1; }
hasher="$repository_root/scripts/hash-password.js"
if [[ ! -f "$hasher" ]]; then hasher=/srv/greece-dance/current/scripts/hash-password.js; fi
[[ -f "$hasher" ]] || { echo 'Cannot find scripts/hash-password.js. Run this from a reviewed checkout.' >&2; exit 1; }

if [[ "$skip_install" == false ]]; then
  bash "$source_directory/install.sh"
fi

mkdir -p "$etc"
if [[ ! -f "$app_env" ]]; then
  if [[ -f "$source_directory/app.env.example" ]]; then
    install -m 0640 "$source_directory/app.env.example" "$app_env"
  else
    echo "Missing $app_env and app.env.example." >&2
    exit 1
  fi
fi
if id greece-dance >/dev/null 2>&1 && [[ "$EUID" == 0 ]]; then
  chown root:greece-dance "$app_env" 2>/dev/null || true
  chmod 0640 "$app_env"
fi

env_value() {
  local key=$1
  [[ -f "$app_env" ]] || return 0
  local line
  line=$(grep -E "^${key}=" "$app_env" | tail -n 1 || true)
  printf '%s' "${line#${key}=}"
}

upsert_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  if grep -qE "^${key}=" "$app_env"; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "${key}="* ]]; then printf '%s=%s\n' "$key" "$value"
      else printf '%s\n' "$line"; fi
    done < "$app_env" > "$tmp"
  else
    cat "$app_env" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$app_env"
  rm -f "$tmp"
}

valid_hash() { [[ "${1:-}" =~ ^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$ ]]; }
prompt() {
  local value=""
  read -r -p "$1" value
  printf '%s' "$value"
}

if [[ -z "$hostname" && "$(env_value APP_ORIGIN)" != https://archive.example.org ]]; then
  hostname=$(env_value APP_ORIGIN)
  hostname=${hostname#https://}
  hostname=${hostname#http://}
fi
if [[ -z "$hostname" && -t 0 ]]; then
  current_origin=$(env_value APP_ORIGIN)
  if [[ -z "$current_origin" || "$current_origin" == https://archive.example.org ]]; then
    hostname=$(prompt 'Domain or droplet IPv4 address (uses sslip.io if an IP): ')
  fi
fi
if [[ "$skip_install" == false && -z "$hostname" ]]; then
  echo 'Pass --hostname with your domain or droplet IPv4 address.' >&2
  exit 1
fi
if [[ "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  "$node_bin" --input-type=module -e 'import { isIP } from "node:net"; process.exit(isIP(process.argv[1]) === 4 ? 0 : 1)' "$hostname" || { echo 'Invalid IPv4 address.' >&2; exit 1; }
  hostname="${hostname//./-}.sslip.io"
fi
if [[ -n "$hostname" ]]; then
  [[ "$hostname" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'Hostname must be a DNS name without https://.' >&2; exit 1; }
  upsert_env APP_ORIGIN "https://$hostname"
  if [[ -f "$nginx_site" ]]; then
    tmp=$(mktemp)
    sed -E "s/server_name[[:space:]]+[^;]+;/server_name $hostname;/" "$nginx_site" > "$tmp"
    cat "$tmp" > "$nginx_site"
    rm -f "$tmp"
  fi
fi

if [[ -z "$repository" ]]; then repository=$(env_value GITHUB_REPOSITORY); fi
if [[ -z "$repository" ]]; then repository=charlieboardman/greece-dance; fi
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Repository must be owner/name.' >&2; exit 1; }
upsert_env GITHUB_REPOSITORY "$repository"

print_github_steps() {
  cat <<EOF

GitHub App (do this in a browser on your laptop, not on the droplet)

1. On your local machine open https://github.com/settings/apps/new
   - GitHub App name: greece-dance-editor (must be unique on GitHub)
   - Homepage URL: $(env_value APP_ORIGIN)
   - Uncheck Webhook → Active
   - Repository permissions: Contents Read and write, Pull requests Read and write
   - Create GitHub App
   - Generate a private key (downloads a .pem to your laptop)
   - Copy the App ID from the app settings page

2. On the app page, click Install App and select only ${repository}.
   After install, the address bar ends with /installations/123456
   That number is the Installation ID.

3. Copy the key onto this droplet, from another local terminal:
   scp -i /path/to/ssh-private-key /path/to/downloaded.pem root@<droplet-ip>:/root/github-app.pem
   Then paste the App ID, Installation ID, and /root/github-app.pem below.

EOF
}

github_ready() {
  [[ "$(env_value GITHUB_APP_ID)" =~ ^[0-9]+$ ]] &&
    [[ "$(env_value GITHUB_INSTALLATION_ID)" =~ ^[0-9]+$ ]] &&
    [[ -f "$pem_destination" ]]
}

update_github=true
if [[ -z "$app_id" && -z "$installation_id" && -z "$pem_source" ]] && github_ready; then
  if [[ -t 0 ]]; then
    reply=$(prompt 'GitHub App credentials are already stored. Replace them? [y/N] ')
    [[ "$reply" == [yY] ]] || update_github=false
  else
    update_github=false
  fi
fi

if [[ "$update_github" == true ]]; then
  if [[ -z "$app_id" || -z "$installation_id" || -z "$pem_source" ]]; then
    print_github_steps
    if [[ ! -t 0 ]]; then
      echo 'Pass --app-id, --installation-id and --pem, or run this script in a terminal.' >&2
      exit 1
    fi
    [[ -n "$app_id" ]] || app_id=$(prompt 'App ID: ')
    [[ -n "$installation_id" ]] || installation_id=$(prompt 'Installation ID: ')
    [[ -n "$pem_source" ]] || pem_source=$(prompt 'Path to the downloaded .pem file: ')
  fi

  [[ "$app_id" =~ ^[0-9]+$ ]] || { echo 'App ID must be a number.' >&2; exit 1; }
  [[ "$installation_id" =~ ^[0-9]+$ ]] || { echo 'Installation ID must be a number.' >&2; exit 1; }
  [[ -f "$pem_source" ]] || { echo "Private key file not found: $pem_source" >&2; exit 1; }
  if ! grep -qE -- '-----BEGIN (RSA )?PRIVATE KEY-----' "$pem_source"; then
    echo 'That file is not a GitHub App private key (.pem).' >&2
    exit 1
  fi
  if [[ -f "$pem_destination" && "$force" != true ]]; then
    if [[ -t 0 ]]; then
      reply=$(prompt "$pem_destination already exists. Replace it? [y/N] ")
      [[ "$reply" == [yY] ]] || { echo 'Keeping the existing private key.'; pem_source=""; }
    else
      echo "$pem_destination already exists. Re-run with --force to replace it." >&2
      exit 1
    fi
  fi
  if [[ -n "$pem_source" ]]; then
    install -m 0640 "$pem_source" "$pem_destination"
    if id greece-dance >/dev/null 2>&1 && [[ "$EUID" == 0 ]]; then
      chown root:greece-dance "$pem_destination"
    fi
  fi
  upsert_env GITHUB_APP_ID "$app_id"
  upsert_env GITHUB_INSTALLATION_ID "$installation_id"
  upsert_env GITHUB_PRIVATE_KEY_FILE "$pem_destination"
fi

github_ready || { echo 'GitHub App credentials are not configured yet.' >&2; exit 1; }

current_hash=$(env_value EDITOR_PASSWORD_HASH)
password=""
if [[ -n "$password_file" ]]; then
  password=$(cat "$password_file")
elif ! valid_hash "$current_hash"; then
  if [[ ! -t 0 ]]; then
    echo 'Pass --password-file or set an editor password in a terminal.' >&2
    exit 1
  fi
  read -rs -p 'Editor password: ' password; echo
  read -rs -p 'Confirm password: ' confirm; echo
  [[ "$password" == "$confirm" ]] || { echo 'Passwords did not match.' >&2; exit 1; }
  unset confirm
fi
if [[ -n "$password" ]]; then
  hash=$(printf '%s' "$password" | "$node_bin" "$hasher")
  unset password
  upsert_env EDITOR_PASSWORD_HASH "$hash"
fi

valid_hash "$(env_value EDITOR_PASSWORD_HASH)" || { echo 'Enter a nonempty editor password.' >&2; exit 1; }

current_secret=$(env_value SESSION_SECRET)
if [[ ${#current_secret} -lt 32 ]]; then
  upsert_env SESSION_SECRET "$("$node_bin" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
fi

if [[ "$skip_install" == false ]]; then
  # Launch starts with the editor disabled and enables it only after verified HTTPS.
  export GREECE_DANCE_ETC="$etc" GREECE_DANCE_NGINX="$nginx_site"
  bash "$source_directory/launch.sh" "$hostname" "${enable_editor:-true}"
  exit 0
fi

if [[ -z "$enable_editor" && -t 0 ]]; then
  reply=$(prompt 'Enable the editor now? Requires HTTPS already serving this host. [y/N] ')
  if [[ "$reply" == [yY] ]]; then enable_editor=true; else enable_editor=false; fi
fi
if [[ "$enable_editor" == true ]]; then upsert_env EDITOR_ENABLED true
elif [[ "$enable_editor" == false ]]; then upsert_env EDITOR_ENABLED false
fi

echo
echo "Wrote $app_env and $pem_destination."
if [[ "$(env_value EDITOR_ENABLED)" == true ]]; then
  echo 'EDITOR_ENABLED=true. Restart greece-dance.service if it is already running.'
else
  echo 'Editor credentials are stored with EDITOR_ENABLED=false until HTTPS is ready.'
  echo 'Then re-run: sudo ./setup.sh --enable-editor'
fi
echo 'First deploy, Nginx and Certbot steps: deploy/README.md'
