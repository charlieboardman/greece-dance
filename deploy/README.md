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
renewal. Setup disables the old automatic update timer; code upgrades stay manual.
Certbot asks for its account details and
terms: enter an email or skip where offered; `c` cancels setup.

The browser steps remain manual: create a GitHub App with **Contents: read/write**
only (PR permission is no longer needed), disable webhooks, install it only on this
repository, and transfer the downloaded private key to the droplet. Setup prints
the instructions. The App ID is on the General settings page; the Installation
ID is the number after `/installations/` in the installation URL. Password input
and generated secrets never appear in command arguments.

The App must be allowed to push directly to the configured canonical branch by
your repository rules. A rejected push keeps the draft and live map intact. Setup
does not change GitHub permissions or branch rules; existing App credentials are
reused. Pending PRs from the previous editor remain untouched.

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
  repository.git/                  Bare partial clone (blob:none)
  operations/<submission-id>.json   Durable save/recovery records (private)
  content.lock                     Cross-process editor/publication lock
/var/lib/greece-dance-content/      Mounted persistent content, owned by app UID
  versions/<commit>-<id>/info/       Immutable validated JSON/Markdown
  current -> versions/...           Atomic published pointer
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
filesystem. Editor state, published content, and temporary files are writable. No Podman socket
or deployment directory is mounted. Compose uses host networking, with Node bound
only to `127.0.0.1:8000`, preserving the existing Nginx connection and loopback proxy
trust when migrating or rolling back older releases. Nginx is the single trusted
proxy. The container shares the host network, but not its writable filesystem.

The editor independently fetches `main`, validates a record change against its
loaded revision, and pushes a content-only commit directly to `main`, without
force-pushing. Competing laptop pushes trigger fresh conflict checks. A partial
clone downloads the archive blobs it needs, not unrelated engine or asset blobs;
old objects already in an existing cache are retained.

After the push, the shared Node publisher fetches `main` again, checks that the
saved commit was accepted, extracts only `info/`, validates the entire staged
archive and switches `current`. No operator working-tree edits enter publication.
The API notices the pointer on the next archive request and replaces its in-memory
archive; refresh an open map tab to see changes. The mounted parent directory must
remain stable: never bind-mount just the `current` symlink.

Editor/CLI operations share a kernel file lock across container processes. Each
save records its ID in the Git commit and private operation state. Interrupted
saves resume after startup; failed saves can be retried with the same ID. Browser
reloads restore the draft and submission ID from tab session storage after login.
An unavailable status endpoint disables submission until it reconnects. Sessions
are cleared on app restart, but draft and operation state survive. Clearing browser
storage loses unsent drafts; accepted commits remain on GitHub.

The Node publisher is `server/publisher.js`; the CLI entry point is
`server/update-info.js`. `update-info.sh` runs that entry point in a disposable
container using the deployed image, service UID, and the same persistent mounts.
It does not build an image or restart the running service. The editor calls the
same module directly. Manual pushes do not publish automatically: run the command.

Full setup is rerunnable: it reuses credentials and state, installs the new mount
and publisher, and publishes validated content before the new app starts. Rerun
setup once when migrating from the old image-bundled content arrangement. Startup
can initialize an empty content volume from GitHub; with existing published content
it starts offline. Do not delete the content volume to perform a routine upgrade.

## Builds, updates and rollback

The administrator-owned Containerfile uses `docker.io/library/node:24-bookworm-slim`.
A build stage installs dependencies and runs validation, all tests and HTTP smoke
checks under Node 24. The final image contains runtime dependencies, app and map
assets, with Git available for the editor. Tests and build tools are omitted.

The update service fetches the canonical branch and skips an unchanged commit
whose image still exists (but still runs content publication). It builds before switching `current`, records the
immutable image ID, restarts Compose, and checks `ok: true` plus the expected
revision at `/api/health`. Content is published through the shared module before
switching the code release. Failed builds leave the running release intact; failed
startup/health checks restore the previous image. A lock serializes updates and
rollback. The first fresh installation has no previous release.

A Node base-image update alone does not trigger deployment. To refresh its patch
version, pull `docker.io/library/node:24-bookworm-slim` with root's Podman and
publish a new app commit so a new image is built. Images are retained locally for
rollback; do not prune images used by `current` or `previous`. Old source snapshots
and unreferenced images can be removed periodically to recover disk space.

From an up-to-date repository checkout, upgrade directly with `sudo ./upgrade.sh`.
The existing update service remains available for manual invocation, but setup
disables its timer. Content-only edits use the faster command below.

```bash
sudo ./upgrade.sh
# Publish accepted content only (no rebuild/restart):
sudo ./update-info.sh
# Or use the installed service:
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

Code rollback does not rewind content. Revert a bad content edit in GitHub and run
`sudo ./update-info.sh`. Content schema changes need a coordinated code deployment;
keep them compatible with any code version retained for rollback.

Use `sudo podman ps` for container status. Installed scripts, Compose and systemd
files are administrator-managed; content updates do not overwrite them. Rerun
setup from the updated checkout for infrastructure changes. Securely back up
`/etc/greece-dance` and retain both persistent volumes when moving servers.
Old content generations are retained for inspection and recovery; remove unused
generations during maintenance only after confirming no running app needs them.
Never edit a published generation in place. Operation records are retained to
support retries; they contain private draft content and must not be web-served.

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

The optional browser check exercises two visitors, reload during publication, and
draft/conflict preservation against a temporary local remote. With Playwright and
its Chromium browser installed, run `node tests/editor-browser.mjs` under Node 24.
Alternatively set `PLAYWRIGHT_MODULE` to an existing Playwright module entry point.
