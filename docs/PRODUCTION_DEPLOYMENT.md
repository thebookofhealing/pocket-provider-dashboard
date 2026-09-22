# Production deployment with a GitHub self-hosted runner

This document is the operational source of truth for deploying `pocket-provider-dashboard` to the production VM.

## Deployment model

Production is deployed by a **repository-level GitHub Actions self-hosted runner** installed on the production VM.

The workflow:

- runs only for pushes to `main` (including merged pull requests)
- requires the runner label `pocket-provider-production`
- has read-only repository permissions
- checks out the exact commit being deployed
- builds a new release away from the live application
- creates and verifies an online SQLite backup before switching `/srv/pocket-provider-dashboard/current`
- reloads both PM2 processes: `pocket-dashboard` and `pocket-indexer`
- verifies `http://127.0.0.1:3100/api/health`
- automatically restores the previous release if activation or health verification fails
- keeps the latest five releases by default

SQLite and production environment configuration are deliberately stored outside release directories.

## Files

- `.github/workflows/deploy-production.yml` — GitHub Actions entry point
- `scripts/deploy-production.sh` — release, validation, activation, rollback, cleanup
- `ecosystem.config.cjs` — PM2 process definition

## One-time VM bootstrap

Use a dedicated unprivileged account for both the runner and the PM2 processes. The examples below use `pocketdeploy`.

Install or verify these system tools:

- Node.js 22 or newer
- npm
- git
- rsync
- curl
- build toolchain required by native npm modules
- PM2 available in the `pocketdeploy` user's PATH

Create the runtime directories:

```bash
sudo useradd --create-home --shell /bin/bash pocketdeploy 2>/dev/null || true

sudo mkdir -p \
  /srv/pocket-provider-dashboard/releases \
  /srv/pocket-provider-dashboard/shared/data

sudo chown -R pocketdeploy:pocketdeploy /srv/pocket-provider-dashboard
sudo chmod 0750 /srv/pocket-provider-dashboard
sudo chmod 0750 /srv/pocket-provider-dashboard/shared
```

The runner account should **not** have unrestricted sudo access. The deploy workflow does not require sudo.

### Production environment file

Create:

```text
/srv/pocket-provider-dashboard/shared/.env.production
```

Minimum persistence requirement:

```bash
POCKET_SQLITE_PATH=/var/lib/pocket-dashboard/pocket.sqlite
```

Add the production Pocket RPC/indexer configuration required by the environment to the same file. Do not commit secrets or production-only values to Git.

Protect it:

```bash
sudo chown pocketdeploy:pocketdeploy /srv/pocket-provider-dashboard/shared/.env.production
sudo chmod 0600 /srv/pocket-provider-dashboard/shared/.env.production
```

The existing production SQLite database remains at the configured persistent path outside `releases/`. The deployment never copies, replaces, truncates, or moves the canonical database.

## Register the GitHub runner

In GitHub open:

`Repository -> Settings -> Actions -> Runners -> New self-hosted runner`

Choose Linux/x64 and execute the download/install commands shown by GitHub as the `pocketdeploy` user. Use a dedicated repository runner, not an organization-wide generic runner.

During configuration use:

- runner name: `pocket-provider-prod-1`
- labels: `pocket-provider-production`
- repository URL: `https://github.com/tsulhc/pocket-provider-dashboard`

Equivalent configuration shape:

```bash
./config.sh \
  --url https://github.com/tsulhc/pocket-provider-dashboard \
  --token <SHORT_LIVED_REGISTRATION_TOKEN_FROM_GITHUB> \
  --name pocket-provider-prod-1 \
  --labels pocket-provider-production \
  --unattended
```

Install the runner as a system service using the service commands included with the downloaded runner package. The service must run as `pocketdeploy`.

After registration, GitHub should show the runner as **Idle** with labels including:

- `self-hosted`
- `linux`
- `x64`
- `pocket-provider-production`

The runner initiates its connection to GitHub. No inbound GitHub-to-runner port is required; allow the VM outbound HTTPS on TCP 443 to the GitHub endpoints required by Actions.

## PM2 boot persistence

The first successful deployment creates/reloads the PM2 applications and runs `pm2 save`.

Configure PM2 startup once on the VM so the saved process list is resurrected after reboot. Run the `pm2 startup` command as `pocketdeploy`, then execute only the exact privileged command printed by PM2.

After that:

```bash
pm2 save
pm2 status
```

## First deployment

Do not merge the deployment workflow until all of these are true:

1. the self-hosted runner is online and Idle
2. Node.js 22+, npm, PM2, rsync and curl are available to the runner service user
3. `/srv/pocket-provider-dashboard/shared/.env.production` exists
4. `POCKET_SQLITE_PATH` points outside `releases/`
5. the production DB, if any, is available at that path

Merging the deployment PR into `main` produces a push to `main` and starts the first deployment automatically.

## Normal deployment

Every later push or merge to `main` runs:

```text
checkout exact commit
    |
create isolated release
    |
npm ci
    |
npm run typecheck
    |
npm run build
    |
verified SQLite backup
    |
switch current symlink
    |
PM2 startOrReload
    |
GET /api/health
    |
pm2 save
```

`concurrency.cancel-in-progress: false` prevents a newer push from interrupting a deployment halfway through activation. The web process uses `POCKET_DB_READONLY=true`; the indexer is the only canonical SQLite writer.

## Verification

On the VM:

```bash
readlink -f /srv/pocket-provider-dashboard/current
pm2 status
curl -fsS http://127.0.0.1:3100/api/health
pm2 logs pocket-dashboard --lines 100
pm2 logs pocket-indexer --lines 100
# confirm both processes are online and indexer height/heartbeat advances
```

In GitHub, the `Deploy production` workflow run should finish successfully on runner `pocket-provider-prod-1`.

## Rollback behavior

The deploy script creates a verified online backup before activation. If the new release fails after the `current` symlink is switched, it automatically:

1. switches `current` back to the previous release
2. reloads the previous PM2 configuration
3. saves the restored PM2 process list
4. removes the failed release
5. marks the GitHub Actions job failed

A build or typecheck failure occurs before activation, so it does not affect the currently running production release.

For a manual rollback, point `current` to a known-good release and reload PM2:

```bash
cd /srv/pocket-provider-dashboard
ls -1t releases

ln -sfn /srv/pocket-provider-dashboard/releases/<GOOD_RELEASE> .current.rollback
mv -Tf .current.rollback current

set -a
. /srv/pocket-provider-dashboard/shared/.env.production
set +a

export DEPLOY_ROOT=/srv/pocket-provider-dashboard
pm2 startOrReload /srv/pocket-provider-dashboard/current/ecosystem.config.cjs --update-env
pm2 save

curl -fsS http://127.0.0.1:3100/api/health
```

## Security notes

The production runner executes repository-controlled shell code directly on the production VM. Treat write access to `main` and the deployment workflow as production access.

For this reason:

- keep this runner repository-scoped and dedicated to this application
- do not add `pull_request` as a trigger for the production job
- do not give the runner user unrestricted sudo
- keep production secrets in the VM-local `.env.production`, not in the repository
- retain `permissions: contents: read` and `persist-credentials: false`
- review changes to `.github/workflows/deploy-production.yml`, `scripts/deploy-production.sh`, and `ecosystem.config.cjs` as privileged production changes

GitHub's own security guidance notes that self-hosted runners are persistent machines rather than clean ephemeral environments. This repository is private, which is the appropriate starting point, but trusted write access remains important.
