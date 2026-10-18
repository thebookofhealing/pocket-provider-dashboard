#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workflow="$root/.github/workflows/deploy-production.yml"
deploy="$root/scripts/deploy-production.sh"
package="$root/package.json"
ecosystem="$root/ecosystem.config.cjs"

[[ "$(tr -d '\r\n' < "$root/.nvmrc")" == "24" ]] || {
  echo ".nvmrc must pin Node 24" >&2
  exit 1
}
grep -q 'actions/checkout@v7' "$workflow"
grep -q 'actions/setup-node@v7' "$workflow"
grep -q 'node-version: 24' "$workflow"
grep -q 'node --version' "$workflow"
grep -q 'npm --version' "$workflow"
if grep -q 'actions/checkout@v4' "$workflow"; then
  echo "workflow still references Node 20-backed checkout@v4" >&2
  exit 1
fi

python3 - "$package" <<'PY'
import json
import sys

package = json.load(open(sys.argv[1], encoding="utf-8"))
assert package["engines"]["node"] == ">=24 <25"
assert package["dependencies"]["better-sqlite3"] == "13.0.3"
assert package["devDependencies"]["@types/node"] == "24.19.2"
assert package["scripts"]["test:runtime"] == "bash scripts/test-node24-runtime.sh"
print("Node 24 package contract checks passed")
PY

grep -q 'node_major != 24' "$deploy"
grep -q 'Node.js 24.x is required' "$deploy"
grep -q 'npm run test:runtime' "$deploy"
grep -q 'verify-pm2-runtime.cjs" 24 pocket-dashboard pocket-indexer' "$deploy"
grep -q 'rollback_runtime_bin' "$deploy"
grep -q '.node-runtime' "$deploy"
grep -q 'interpreter: pinnedNode' "$ecosystem"
grep -q 'node_modules/next/dist/bin/next' "$ecosystem"
grep -q 'node_modules/tsx/dist/cli.mjs' "$ecosystem"
grep -q 'better-sqlite3 Node 24 native smoke test passed' "$root/scripts/test-node24-runtime.cjs"

echo "Node 24 workflow/deploy contract checks passed"
