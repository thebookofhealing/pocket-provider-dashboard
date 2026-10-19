#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$root/scripts/release-runtime.sh"

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocket-release-runtime.XXXXXX")"
cleanup() { rm -rf "$test_dir"; }
trap cleanup EXIT

make_fake_node() {
  local path="$1"
  local major="$2"
  local version="$3"

  printf '%s\n' \
    '#!/bin/sh' \
    'case "$1" in' \
    "  --version) printf '%s\\n' '$version' ;;" \
    "  -p) printf '%s\\n' '$major' ;;" \
    '  *) exit 1 ;;' \
    'esac' > "$path"
  chmod 0755 "$path"
}

make_fake_npm() {
  local path="$1"

  printf '%s\n' \
    '#!/bin/sh' \
    '[ "$1" = "--version" ] || exit 1' \
    "printf '%s\\n' '10.9.3'" > "$path"
  chmod 0755 "$path"
}

legacy="$test_dir/legacy"
pinned="$test_dir/pinned"
wrong_major_dir="$test_dir/node24"
missing_npm_dir="$test_dir/node22-missing-npm"
valid_dir="$test_dir/node22"
mkdir -p "$legacy" "$pinned" "$wrong_major_dir" "$missing_npm_dir" "$valid_dir"

# A legacy release cannot resolve a rollback runtime without an explicit
# fallback path.
if resolve_release_runtime "$legacy" "" >/dev/null; then
  echo "legacy release without a fallback runtime unexpectedly resolved" >&2
  exit 1
fi

# A fallback that reports Node 24 is not a valid first-migration rollback.
make_fake_node "$wrong_major_dir/node" 24 v24.19.0
make_fake_npm "$wrong_major_dir/npm"
if validate_legacy_rollback_runtime "$wrong_major_dir/node"; then
  echo "legacy Node 24 fallback unexpectedly passed validation" >&2
  exit 1
fi

# A Node 22 fallback without its companion npm must fail closed, even if an
# unrelated npm happens to be available later on PATH.
make_fake_node "$missing_npm_dir/node" 22 v22.20.0
if validate_legacy_rollback_runtime "$missing_npm_dir/node"; then
  echo "legacy runtime without companion npm unexpectedly passed validation" >&2
  exit 1
fi

# A retained Node 22 executable and its matching npm are a valid first-
# migration rollback pair.
make_fake_node "$valid_dir/node" 22 v22.20.0
make_fake_npm "$valid_dir/npm"
validate_legacy_rollback_runtime "$valid_dir/node"

# Once a release carries a pin, it must win over the legacy fallback.
make_fake_node "$pinned/node" 24 v24.19.0
printf '%s\n' "$pinned/node" > "$pinned/.node-runtime"
resolved_pinned="$(resolve_release_runtime "$pinned" "$valid_dir/node")"
[[ "$resolved_pinned" == "$pinned/node" ]] || {
  echo "pinned release did not use its .node-runtime path" >&2
  exit 1
}

echo "release runtime rollback validation checks passed"
