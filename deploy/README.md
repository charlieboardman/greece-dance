# Podman Compose deployment

The app runs in a read-only Podman container built from the
[official Node.js 24 Debian image](https://hub.docker.com/_/node). Nginx and Certbot stay on the Ubuntu/Debian host. systemd manages
`podman compose` at boot and restarts it if the app exits. The host needs neither
Node.js nor npm. Setup installs Podman and its `podman-compose` provider.

## First setup or migration from the host-Node deployment

From an up-to-date checkout on the droplet:

```bash
git pull --ff-only origin main
sudo ./setup.sh --hostname 165-227-25-230.sslip.io
```

Use your own hostname or public IPv4 address. An IPv4 is automatically converted
to a dashed sslip.io hostname; a purchased domain is optional. Allow inbound SSH,
HTTP (80) and HTTPS (443) in any host or DigitalOcean firewall. If you use your own
domain, point its DNS to the droplet before setup. Setup leaves firewall rules to
the operator.

Setup installs packages, pulls the Node 24 helper image, asks for GitHub App
credentials and an editor password, builds/tests the app image, starts Compose,
configures Nginx and HTTPS, verifies health, and enables the editor, certificate
renewal and the five-minute update timer. Certbot asks for its account details and
terms: enter an email or skip where offered; `c` cancels setup.

The browser steps remain manual: create a GitHub App with **Contents: read/write**
and **Pull requests: read/write**, disable webhooks, install it only on this
repository, and transfer the downloaded private key to the droplet. Setup prints
the instructions. The App ID is on the General settings page; the Installation
ID is the number after `/installations/` in the installation URL. Password input
and generated secrets never appear in command arguments.

Rerun the same setup command after failure. Saved credentials, passwords, Nginx
configuration and certificates are preserved. A previous host-Node release is
built into a separate rollback image before switching to Compose; its original
files are left untouched. The old host Node installation is no longer required
and is left installed. The existing service names, editor state directory and
credential paths remain the same. Expect a brief interruption when replacing the
running service.

The deployment remote/branch must already contain the application code you want
to run. Defaults in `/etc/greece-dance/deploy.env` are this repository and `main`.
For a private repository, configure a read-only SSH deploy key under the
`greece-deploy` account and use its SSH remote there. That account only fetches
Git objects; it has no Podman or restart privileges. `--repository` selects the
editor's GitHub repository; configure `deploy.env` separately for a different
deployment remote.

Advanced options:

- `--disable-editor`: complete HTTPS deployment but leave editing disabled.
- `--skip-install`: configure credentials only, using the Node 24 helper
  container; does not install packages, deploy, obtain HTTPS or restart services.
- `--enable-editor`: enable editing; full setup verifies HTTPS first. With
  `--skip-install`, HTTPS must already work and you must restart the app afterward.
- `sudo bash deploy/install.sh`: install service definitions only; requires the
  prerequisites already installed and does not start services.

## Storage and credentials

```text
/srv/greece-dance/
  repository.git/                   Git deployment cache (greece-deploy)
  releases/podman-<commit>/         Source snapshot, .release-sha, .container-image
  releases/legacy-container-<sha>/  Migrated rollback image metadata
  current -> releases/...
  previous -> releases/...
/var/lib/containers/storage/        Root's Podman images and containers
/var/lib/greece-dance-editor/       Persistent editor Git workspace
/etc/greece-dance/
  app.env                          Runtime settings, password hash, session secret
  deploy.env                       Canonical deployment remote and branch
  github-app.pem                   GitHub App private key
/usr/local/lib/greece-dance/deploy/ Administrator-managed scripts and compose.yaml
```

Builds use Git snapshots, explicit Containerfile COPY paths, and an ignore file.
No credentials or editor state enter the image. Compose mounts `/etc/greece-dance`
read-only; **Node reads `app.env` inside the container**. Compose does not expand
secrets into Podman arguments or environment metadata. The app runs with the
existing `greece-dance` UID/GID, no Linux capabilities, and a read-only root
filesystem. Only editor state and temporary files are writable. No Podman socket
or deployment directory is mounted. Compose uses host networking, with Node bound
only to `127.0.0.1:8000`, preserving the existing Nginx connection and loopback proxy
trust when migrating or rolling back older releases. Nginx is the single trusted
proxy. The container shares the host network, but not its writable filesystem.

The editor independently reads `main`, creates content-only proposal branches and
PRs, and never writes into the deployed image. Review and merge PRs in GitHub.
Existing conflict detection and retry behavior are unchanged. Protect `main`
with repository review/validation rules. Sessions are cleared on container restart;
the editor Git workspace persists.

## Builds, updates and rollback

The administrator-owned Containerfile uses `docker.io/library/node:24-bookworm-slim`.
A build stage installs dependencies and runs validation, all tests and HTTP smoke
checks under Node 24. The final image contains runtime dependencies, app and map
assets, with Git available for the editor. Tests and build tools are omitted.

The update service fetches the canonical branch and skips an unchanged commit
whose image still exists. It builds before switching `current`, records the
immutable image ID, restarts Compose, and checks `ok: true` plus the expected
revision at `/api/health`. Failed builds leave the running release intact; failed
startup/health checks restore the previous image. A lock serializes updates and
rollback. The first fresh installation has no previous release.

A Node base-image update alone does not trigger deployment. To refresh its patch
version, pull `docker.io/library/node:24-bookworm-slim` with root's Podman and
publish a new app commit so a new image is built. Images are retained locally for
rollback; do not prune images used by `current` or `previous`. Old source snapshots
and unreferenced images can be removed periodically to recover disk space.

```bash
sudo systemctl start greece-dance-update.service
sudo journalctl -u greece-dance-update.service -f
sudo journalctl -u greece-dance.service -f
```

Manual rollback:

```bash
sudo systemctl stop greece-dance-update.timer
# Wait for any in-progress update to finish.
sudo /usr/local/lib/greece-dance/deploy/rollback.sh
```

Fix or revert the offending commit in GitHub before re-enabling the timer:

```bash
sudo systemctl enable --now greece-dance-update.timer
```

Use `sudo podman ps` for container status. Installed scripts, Compose and systemd
files are administrator-managed; content updates do not overwrite them. Rerun
setup from the updated checkout for infrastructure changes. Securely back up
`/etc/greece-dance` and retain `/var/lib/greece-dance-editor` when moving servers.

## Local verification

Use Node.js 24 for local development and `npm run validate && npm test`. Deployment
unit tests use temporary local remotes and fake service/build hooks. To build and
test a real image with rootless Podman and `podman-compose` installed:

```bash
podman build -f deploy/Containerfile --ignorefile deploy/containerignore \
  --build-arg RELEASE_SHA=local-test -t localhost/greece-dance:test .
node deploy/check-container.mjs localhost/greece-dance:test
```

The opt-in Compose check creates temporary credentials/state and an ephemeral local
port. It checks Node 24, the map, byte ranges, an editor login through the proxy
headers, a read-only app filesystem, and persistence after recreation. It never
contacts GitHub or production infrastructure. Test resources are removed afterward.
