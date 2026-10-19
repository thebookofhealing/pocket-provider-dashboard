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
