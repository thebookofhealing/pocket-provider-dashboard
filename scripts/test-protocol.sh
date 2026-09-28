#!/usr/bin/env bash
set -euo pipefail

# Protocol tests must never open the application's configured database. This
# wrapper runs before tsx imports lib/db.ts, so the isolated path is in place
# before better-sqlite3 initializes.
configured_db="${POCKET_SQLITE_PATH:-}"
configured_fingerprint=""
if [[ -n "$configured_db" && -f "$configured_db" ]]; then
  configured_fingerprint="$(shasum "$configured_db")"
fi

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocket-dashboard-test-protocol.XXXXXX")"
test_db="$test_dir/test.sqlite"
cleanup() {
  rm -f "$test_db" "$test_db-wal" "$test_db-shm"
  rmdir "$test_dir" 2>/dev/null || true
}
trap cleanup EXIT

export POCKET_SQLITE_PATH="$test_db"
export POCKET_DB_READONLY=false

status=0
./node_modules/.bin/tsx scripts/test-protocol.ts || status=$?

if [[ -n "$configured_fingerprint" && -f "$configured_db" ]]; then
  if [[ "$(shasum "$configured_db")" != "$configured_fingerprint" ]]; then
    echo "test:protocol mutated the configured application database" >&2
    status=1
  fi
fi

exit "$status"
