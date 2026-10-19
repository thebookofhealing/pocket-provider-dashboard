#!/usr/bin/env bash

# Resolve the runtime pinned by a release. Legacy releases may not have a
# .node-runtime file, so callers must provide the explicitly configured
# rollback runtime for that first migration.
resolve_release_runtime() {
  local release_dir="$1"
  local fallback_runtime="${2:-}"
  local pinned_file="$release_dir/.node-runtime"

  if [[ -f "$pinned_file" ]]; then
    tr -d '[:space:]' < "$pinned_file"
  elif [[ -n "$fallback_runtime" ]]; then
    printf '%s\n' "$fallback_runtime"
  else
    return 1
  fi
}

# Validate the explicit rollback runtime required while rolling back to a
# pre-Node-24 release. Those legacy releases do not carry a .node-runtime
# pin, so accepting an arbitrary executable (or a later npm on PATH) would
# make the first migration non-deterministic.
validate_legacy_rollback_runtime() {
  local runtime_bin="$1"
  [[ "$runtime_bin" = /* && -x "$runtime_bin" ]] || return 1

  local runtime_dir="${runtime_bin%/*}"
  local npm_bin="${runtime_dir}/npm"
  [[ -x "$npm_bin" ]] || return 1

  local runtime_major
  runtime_major="$("$runtime_bin" -p 'Number(process.versions.node.split(".")[0])')" || return 1
  [[ "$runtime_major" =~ ^22$ ]] || return 1

  # Select the matching runtime directory while invoking the companion npm;
  # do not allow npm to fall through to an unrelated PATH entry.
  PATH="$runtime_dir:$PATH" "$npm_bin" --version >/dev/null || return 1
}
