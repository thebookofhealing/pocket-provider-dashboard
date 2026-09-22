#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/pocket-provider-dashboard}"
RELEASES_DIR="${DEPLOY_ROOT}/releases"
SHARED_DIR="${DEPLOY_ROOT}/shared"
CURRENT_LINK="${DEPLOY_ROOT}/current"
ENV_FILE="${ENV_FILE:-${SHARED_DIR}/.env.production}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

atomic_switch() {
  local target="$1"
  local tmp_link="${DEPLOY_ROOT}/.current.new.$$"

  ln -sfn "$target" "$tmp_link"
  mv -Tf "$tmp_link" "$CURRENT_LINK"
}

load_runtime_env() {
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

for cmd in git node npm pm2 rsync curl readlink python3; do
  require_command "$cmd"
done

[[ "${GITHUB_EVENT_NAME:-}" == "push" ]] || fail "production deploy requires a push event"
[[ "${GITHUB_REF:-}" == "refs/heads/main" ]] || fail "production deploy requires refs/heads/main"
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "GITHUB_SHA must be a full commit SHA"

actual_sha="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
[[ "$actual_sha" == "$GITHUB_SHA" ]] || fail "checkout SHA $actual_sha does not match GITHUB_SHA $GITHUB_SHA"

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( node_major < 22 )); then
  fail "Node.js 22+ is required; found $(node --version)"
fi

[[ -f "$ENV_FILE" ]] || fail "missing production environment file: $ENV_FILE"
load_runtime_env

[[ -n "${POCKET_SQLITE_PATH:-}" ]] || fail "POCKET_SQLITE_PATH must be set in $ENV_FILE"
[[ "$POCKET_SQLITE_PATH" = /* ]] || fail "POCKET_SQLITE_PATH must be absolute"
[[ "$POCKET_SQLITE_PATH" != "$RELEASES_DIR"/* ]] || fail "POCKET_SQLITE_PATH must be outside releases"
[[ -f "$POCKET_SQLITE_PATH" ]] || fail "canonical SQLite database is missing"
[[ -r "$POCKET_SQLITE_PATH" ]] || fail "canonical SQLite database is not readable"

POCKET_BACKUP_DIR="${POCKET_BACKUP_DIR:-/var/backups/pocket-dashboard}"
export POCKET_BACKUP_DIR
[[ -d "$POCKET_BACKUP_DIR" && -w "$POCKET_BACKUP_DIR" ]] || fail "backup directory is not writable"

mkdir -p "$RELEASES_DIR" "$SHARED_DIR"

release_id="$GITHUB_SHA"
release_dir="${RELEASES_DIR}/${release_id}"
if [[ -e "$release_dir" ]]; then
  if [[ -L "$CURRENT_LINK" && "$(readlink -f "$CURRENT_LINK")" == "$release_dir" ]]; then
    log "SHA already active: $release_id"
    exit 0
  fi
  fail "release already exists but is not active: $release_dir"
fi

previous_release=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(readlink -f "$CURRENT_LINK" || true)"
fi
[[ -n "$previous_release" && -d "$previous_release" ]] || fail "no previous known-good release is available"

activated=0

rollback() {
  local exit_code="$1"

  if (( activated == 1 )); then
    log "deployment failed after activation; rolling back to $(basename "$previous_release")"
    atomic_switch "$previous_release"
    load_runtime_env
    pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env || true
    pm2 save || true
  fi

  if [[ -d "$release_dir" && "$release_dir" != "$previous_release" ]]; then
    rm -rf "$release_dir" || true
  fi

  exit "$exit_code"
}

on_error() {
  local exit_code=$?
  trap - ERR
  rollback "$exit_code"
}
trap on_error ERR

log "creating release $release_id from exact checkout"
mkdir -p "$release_dir"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='data/' \
  --exclude='.env*' \
  "$SOURCE_ROOT/" "$release_dir/"
ln -s "$ENV_FILE" "$release_dir/.env.production"

cd "$release_dir"
log "installing dependencies"
env -u NODE_ENV npm ci

log "running typecheck"
NODE_ENV=production POCKET_DB_READONLY=true npm run typecheck

log "building Next.js application read-only"
NODE_ENV=production POCKET_DB_READONLY=true npm run build

log "creating and verifying online SQLite backup"
python3 "$release_dir/scripts/backup.py" \
  --db "$POCKET_SQLITE_PATH" \
  --backup-dir "$POCKET_BACKUP_DIR" \
  --retention 7

log "activating release $release_id"
atomic_switch "$release_dir"
activated=1

load_runtime_env
export DEPLOY_ROOT
log "reloading PM2 web and indexer"
pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env

log "verifying web and indexer"
healthy=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null \
    && curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/ >/dev/null \
    && [[ -n "$(pm2 pid pocket-dashboard)" ]] \
    && [[ -n "$(pm2 pid pocket-indexer)" ]]; then
    healthy=1
    break
  fi
  sleep 2
done

(( healthy == 1 )) || fail "web/indexer health verification failed"
[[ "$(readlink -f "$CURRENT_LINK")" == "$release_dir" ]] || fail "current does not point to deployed SHA"

pm2 save

current_target="$(readlink -f "$CURRENT_LINK")"
mapfile -t all_releases < <(
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr |
    cut -d' ' -f2-
)

if (( ${#all_releases[@]} > KEEP_RELEASES )); then
  for (( i=KEEP_RELEASES; i<${#all_releases[@]}; i++ )); do
    old_release="${all_releases[$i]}"
    if [[ "$old_release" != "$current_target" && "$old_release" != "$previous_release" ]]; then
      rm -rf "$old_release"
      log "removed old release $(basename "$old_release")"
    fi
  done
fi

trap - ERR
log "deployment successful: $release_id"
