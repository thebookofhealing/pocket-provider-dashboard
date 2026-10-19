#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$root/scripts/release-runtime.sh"

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocket-release-runtime.XXXXXX")"
cleanup() { rm -rf "$test_dir"; }
trap cleanup EXIT

legacy="$test_dir/legacy"
pinned="$test_dir/pinned"
mkdir -p "$legacy" "$pinned"

fallback="$(command -v sh)"
resolved_legacy="$(resolve_release_runtime "$legacy" "$fallback")"
[[ "$resolved_legacy" == "$fallback" ]] || {
  echo "legacy release did not use the explicit rollback runtime" >&2
  exit 1
}

printf '%s\n' "$fallback" > "$pinned/.node-runtime"
resolved_pinned="$(resolve_release_runtime "$pinned" "$test_dir/should-not-be-used")"
[[ "$resolved_pinned" == "$fallback" ]] || {
  echo "pinned release did not use its .node-runtime path" >&2
  exit 1
}

if resolve_release_runtime "$legacy" "" >/dev/null; then
  echo "legacy release without a fallback runtime unexpectedly resolved" >&2
  exit 1
fi

echo "release runtime rollback resolution checks passed"
