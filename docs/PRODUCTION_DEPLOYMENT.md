# Production deployment

Production is deployed automatically from the canonical `main` branch by one repository-scoped GitHub Actions self-hosted runner.

## Runner boundary

- Repository: `tsulhc/pocket-provider-dashboard`
- Required labels: `self-hosted`, `linux`, `x64`, `pocket-provider-production`
- The runner runs as the dedicated unprivileged deployment account and is not shared with other repositories.
- Registration tokens are short-lived setup credentials. Never commit, persist, or print them.
- The workflow has `contents: read` only and runs on `push` to `main`; pull requests and arbitrary refs never execute on the production runner.
- Deployments use one non-canceling concurrency group, so production activations are serialized.

## Host layout

The workflow uses `/srv/pocket-provider-dashboard` as its deployment root:

```text
/srv/pocket-provider-dashboard/
  current -> releases/<full-git-sha>
  releases/<full-git-sha>/       immutable application release
  shared/.env.production         production environment, outside releases
```

The canonical SQLite database, WAL/SHM files, and backups remain outside `releases/`. The database path is supplied by `POCKET_SQLITE_PATH` in the VM-local environment file and must be absolute, persistent, readable, and outside the release tree. Backups are stored in the VM-local `POCKET_BACKUP_DIR` (default `/var/backups/pocket-dashboard`).

## Deployment sequence

For the exact pushed `main` SHA, the workflow:

1. checks out that full SHA;
2. creates a SHA-keyed release directory;
3. runs `npm ci`, `npm run typecheck`, and `npm run build`;
4. validates the persistent environment and database prerequisites;
5. creates and integrity-checks an online SQLite backup before activation;
6. atomically switches `current` to the new release;
7. reloads the PM2 web and indexer processes from `current`;
8. verifies local HTTP health, both PM2 processes, indexer lock/height stability, and the active SHA;
9. retains the immediate previous release and bounded older-release history.

The web process uses `POCKET_DB_READONLY=true`; the indexer is the sole canonical database writer. A failed build, typecheck, prerequisite check, or backup leaves the current release untouched. A post-activation health failure switches application code back to the immediate previous release and restarts PM2 without restoring or replacing SQLite.

## Verification

```bash
pm2 status
curl --fail http://127.0.0.1:3100/
curl --fail http://127.0.0.1:3100/api/health
readlink -f /srv/pocket-provider-dashboard/current
```

The deployment log records the triggering/deployed SHA, backup verification, PM2 status, web health, and stable indexer samples without printing environment values or credentials.

## Application rollback

Rollback is application-only:

1. identify the immediate previous SHA-keyed directory under `releases/`;
2. atomically point `current` to that directory;
3. load the VM-local environment and PM2 configuration;
4. reload the web and indexer processes;
5. verify HTTP, PM2, indexer health, and unchanged canonical DB path;
6. document the deployed and rollback SHAs.

The rollback path supports the pre-runner `eeb4933` baseline, which does not contain a checked-in PM2 ecosystem file; it falls back to the still-present candidate configuration when needed. Never delete WAL/SHM files or overwrite/restore the live database automatically. Any data restore is a separate, reviewed recovery operation using a verified backup.

## Disable or replace the runner

To disable automatic deployment, disable the `Deploy production` workflow or stop the dedicated runner service. Do not delete releases, the database, WAL/SHM files, or backups. To replace the runner, take the old service offline, remove its repository registration in GitHub, then register the replacement with a new short-lived token and the same labels.

## Current closeout evidence

The first controlled deployment completed successfully for `849b3d7e1ac0230588bb5925d55a070537e4337a`. Its workflow run performed the build/typecheck, verified an online SQLite backup before activation, reloaded both PM2 processes, and observed five stable indexer health samples. Historical contiguous-height repair remains tracked separately in issue #5.
