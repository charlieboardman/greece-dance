# Droplet deployment

Runtime: Node.js 24 LTS behind Nginx on Ubuntu/Debian with systemd. Installation,
update, health-check and rollback infrastructure is included. No DigitalOcean
resources are created by this repository.

## Layout and separation

```text
/srv/greece-dance/
  repository.git/         Deployment cache of GitHub
  releases/<commit>/      Complete app, dependencies, content and .release-sha
  current -> releases/<commit>
  previous -> releases/<commit>
/var/lib/greece-dance-editor/repository.git/  Separate editor Git object store
/etc/greece-dance/
  app.env                Runtime settings, password hash and session secret
  deploy.env             Canonical remote and deployment settings
  github-app.pem         Private GitHub App key, when editor is enabled
/usr/local/lib/greece-dance/deploy/          Administrator-owned scripts
```

The `greece-dance` service account can write only editor state and temporary
files. It cannot modify releases. `greece-deploy` owns releases and can restart
only `greece-dance.service` through a narrowly scoped sudoers rule. It cannot
read editor credentials. Public repositories need no deployment credentials.
For a private repository, configure a read-only SSH deploy key for
`greece-deploy` and use an SSH remote in `deploy.env`.

## Guided first installation

On an Ubuntu/Debian droplet, clone this repository and run from the checkout:

```bash
sudo ./setup.sh --hostname 165.227.25.230
```

Replace the example IP with your droplet's public IPv4 address, or supply a domain
that already points to it. An IPv4 address is converted to a dashed `sslip.io`
hostname automatically, so purchasing a domain is optional. This uses sslip.io's
external DNS service. Permit inbound SSH, HTTP (80), and HTTPS (443), including in
any DigitalOcean firewall. Setup does not modify firewall rules.

Full setup installs system packages, Node.js 24 at `/usr/bin/node` using
NodeSource when needed, and npm dependencies before prompting for credentials.
It installs the service definitions, stores GitHub App credentials and the editor
password, deploys through the existing validated release mechanism, activates
Nginx, runs Certbot, enables certificate renewal, verifies HTTPS, then enables the
editor and automatic deployment timer. Certbot prompts for its account details
and terms. The GitHub App creation/installation and transferring its downloaded
key still require your browser and laptop; setup prints instructions.

The canonical deployment remote and branch are in `/etc/greece-dance/deploy.env`
(default `charlieboardman/greece-dance`, `main`). Merge the deployment/server code
into that branch before running setup. For a private repository, first configure
the read-only deployment SSH key described above. A custom `--repository` selects
the editor's repository; also configure `deploy.env` for a custom deployment remote.

Rerun the same command after a failure. Existing credentials and passwords are
reused unless you request replacement; an existing Nginx symlink is accepted and
matching certificates are retained. Failures before HTTPS verification leave the
editor disabled and automatic deployment paused. Already deployed releases stay
under the deployment system's control. Setup prints a diagnostic when deployment
fails; inspect `journalctl -u greece-dance-update.service --no-pager -n 100`.

For credentials-only administration without package installation or deployment:

```bash
sudo ./setup.sh --skip-install
```

This advanced mode requires Node.js 24 and installed checkout dependencies
(`npm ci --omit=dev --ignore-scripts`). It does not configure HTTPS or restart
services. For infrastructure-only installation, `sudo bash deploy/install.sh`
remains available and requires preinstalled system prerequisites.

## Enable the password-protected editor

GitHub has no API for creating this login from a script. `./setup.sh` prints
two URLs. Open them in a browser on your laptop (you can stay SSH’d into the
droplet), create the App, install it only on this repository, then `scp` the
downloaded `.pem` onto the droplet. The script stores that key, the App ID,
installation ID, password hash and session secret in `/etc/greece-dance`.
Webhooks are not used. Permissions: **Contents: read/write** and **Pull
requests: read/write**.

```bash
sudo ./setup.sh
```

Full setup keeps `EDITOR_ENABLED=false` until HTTPS works, then enables the editor
and restarts `greece-dance.service` automatically. Use `--disable-editor` to leave
it disabled. Open `/editor/` over HTTPS. Sessions expire
after eight hours of inactivity and are cleared on service restart. Form input
stays on the page when a session expires so the editor can log in again without
discarding it.

The app reads current `main` from GitHub, independently of the deployed version.
It pushes an `editor/<submission-id>` branch and opens a PR. Repository rules
should require review/validation on `main`; allow the app to create proposal
branches without granting it a bypass for `main`. The app does not merge PRs.
Edits to the same record or its parent trigger a conflict; unrelated changes
are retained automatically. A failed PR request after a successful push can
be retried from the unchanged preview without another commit or PR. The branch
also remains available in GitHub for manual recovery.

## Updates and rollback

The timer runs `update.sh` five minutes after the preceding run finishes. It
fetches the canonical branch and skips an unchanged revision. New revisions
are extracted to staging; `npm ci --omit=dev --ignore-scripts`, validation,
tests and HTTP smoke checks must pass before replacing `current` and restarting
Node. Health checks require `ok: true` and the expected commit SHA. Nginx proxies
to Node so public files and data come from the same complete release.

A backend restart can cause a brief interruption. Failed preparation leaves
the live release alone. A failed restart/health check restores and restarts the
previous release. The first deployment has no previous release to restore.
An exclusive lock prevents concurrent deployments and rollbacks.

Trigger a check manually:

```bash
sudo systemctl start greece-dance-update.service
```

For manual rollback, stop the timer so it cannot redeploy the unwanted commit.
Let any in-progress update finish before running rollback:

```bash
sudo systemctl stop greece-dance-update.timer
sudo -u greece-deploy /usr/local/lib/greece-dance/deploy/rollback.sh
```

Revert or fix the offending change in GitHub, then re-enable the timer. Rollback
exchanges `current` and `previous`; run it again to restore the other version.
Update refuses to overwrite the release retained by `previous`.

Logs: `journalctl -u greece-dance.service` and
`journalctl -u greece-dance-update.service`. `/api/health` reports the deployed
revision. Historical release directories are retained; periodically remove old
ones while keeping `current` and `previous`. Source/assets live in GitHub;
back up `/etc/greece-dance` securely and retain editor state when moving servers.
Never commit credentials or runtime state.

Installed scripts and service/Nginx definitions are administrator-managed:
ordinary content deployments do not overwrite them. Re-run the installer from
a reviewed checkout for infrastructure changes, then reload/restart relevant
services. Existing environment files are preserved.
