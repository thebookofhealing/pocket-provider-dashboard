#!/usr/bin/env bash
set -Eeuo pipefail

# Deterministic guard for the post-deploy contract: dashboard and Staking must
# run before the health read whose diagnostics are asserted. This catches the
# cold-process ordering regression without requiring a production server.
script="$(cd "$(dirname "$0")" && pwd)/verify-production-data.sh"
dashboard_line="$(grep -n 'fetch_with_retry "\$LOCAL_BASE_URL/api/dashboard?window=30d"' "$script" | cut -d: -f1)"
staking_line="$(grep -n 'fetch_with_retry "\$LOCAL_BASE_URL/staking"' "$script" | cut -d: -f1)"
health_line="$(grep -n 'fetch_with_retry "\$LOCAL_BASE_URL/api/health"' "$script" | cut -d: -f1)"

[[ -n "$dashboard_line" && -n "$staking_line" && -n "$health_line" ]] || {
  echo "verifier endpoint fetches are incomplete" >&2
  exit 1
}
(( dashboard_line < staking_line && staking_line < health_line )) || {
  echo "verifier must fetch dashboard, then staking, then health" >&2
  exit 1
}

bash -n "$script"
grep -q 'snapshotSchemaVersion") == 3' "$script"
grep -q 'clientShareSource' "$script"
bash "$(cd "$(dirname "$script")" && pwd)/test-staking-readiness.sh"

staking_page="$(cd "$(dirname "$script")/.." && pwd)/app/staking/page.tsx"
if grep -Eq 'fetchLivePlans|fetch\(' "$staking_page"; then
  echo "staking page must not contain request-time upstream fetches" >&2
  exit 1
fi

echo "production verifier warm-cache ordering passed"
