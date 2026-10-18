#!/usr/bin/env bash
set -Eeuo pipefail

node_version="$(node --version)"
npm_version="$(npm --version)"
node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( node_major != 24 )); then
  printf 'Node.js 24.x is required for the runtime smoke test; found %s\n' "$node_version" >&2
  exit 1
fi

printf 'runtime smoke test: Node.js %s; npm %s\n' "$node_version" "$npm_version"
node "$(cd "$(dirname "$0")" && pwd)/test-node24-runtime.cjs"
