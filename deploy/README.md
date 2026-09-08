# Droplet deployment (prepared, not yet installed)

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

## Future first installation

Install Node.js **24 LTS at `/usr/bin/node`**, npm, Git, Nginx, curl, util-linux
(flock), sudo, Certbot and the Certbot Nginx plugin. Point the domain's DNS at the
droplet. Permit SSH and HTTP/HTTPS; Node listens only on loopback.

From a reviewed checkout after this migration is merged:

```bash
sudo bash deploy/install.sh
```

The installer installs files and reloads systemd definitions. It does not
deploy, start the app, enable the timer, overwrite existing environment files,
or activate the Nginx site. Configure:

- `/etc/greece-dance/app.env`: `APP_ORIGIN=https://your-hostname`
- `/etc/nginx/sites-available/greece-dance`: `server_name your-hostname`
- `/etc/greece-dance/deploy.env`: verify remote and branch (`main`)

Keep `EDITOR_ENABLED=false` until HTTPS and GitHub credentials are configured.
The public map runs independently of the editor.

```bash
sudo systemctl start greece-dance-update.service
sudo journalctl -u greece-dance-update.service --no-pager -n 100
sudo ln -s /etc/nginx/sites-available/greece-dance /etc/nginx/sites-enabled/greece-dance
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d your-hostname
sudo systemctl enable greece-dance.service
sudo systemctl enable --now greece-dance-update.timer
```

Adjust any conflicting default Nginx site. Certbot configures TLS and the HTTP
redirect; the included Nginx file is the initial HTTP configuration used to
obtain that certificate.

## Enable the password-protected editor

Create a GitHub App, install it **only on this repository**, and grant repository
**Contents: read/write** and **Pull requests: read/write**. Metadata read access
is implicit. Webhooks and user authorization callbacks are not needed. Generate
a private key and record the App ID and installation ID.

Generate the password hash with `npm run password:hash`. Generate a session
secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the hash, secret, app/installation IDs, repository, and key path in
`/etc/greece-dance/app.env`. Install the key as root with group `greece-dance`
and mode `0640`; keep `app.env` at the same ownership/mode. Set
`EDITOR_ENABLED=true` and restart `greece-dance.service`. Open `/editor/` over
HTTPS. Sessions expire after eight hours of inactivity and are cleared on
service restart. Form input stays on the page when a session expires so the
editor can log in again without discarding it.

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
