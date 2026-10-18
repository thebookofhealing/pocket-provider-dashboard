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
bash "$(cd "$(dirname "$script")" && pwd)/test-dashboard-readiness.sh"
python3 "$(cd "$(dirname "$script")" && pwd)/test-production-verifier-behavior.py"

deploy_script="$(cd "$(dirname "$script")" && pwd)/deploy-production.sh"
grep -q "dashboard_readiness.py" "$deploy_script"
grep -q "dashboard_status.*200" "$deploy_script"
grep -q "api/dashboard?window=30d" "$deploy_script"
python3 - "$deploy_script" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
start = source.index("log \"verifying web")
end = source.index("pm2 save", start)
readiness = source[start:end]
assert "dashboard_readiness.py" in readiness, "deploy readiness must validate dashboard contract"
assert "dashboard_status" in readiness and '== "200"' in readiness, "deploy readiness must require HTTP 200, not merely curl success"
assert "staking_readiness.py" in readiness, "deploy readiness must retain Staking v3 gate"
print("deployment readiness contract checks passed")
PY

indexer_script="$(cd "$(dirname "$script")/.." && pwd)/lib/indexer.ts"
python3 - "$indexer_script" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
rebuild_start = source.index("export async function rebuildIndexerCaches")
rebuild_end = source.index("async function maybeRebuildCaches", rebuild_start)
rebuild = source[rebuild_start:rebuild_end]
assert "maybeRefreshStakingSnapshot" not in rebuild, "dashboard cache rebuild must not await Staking refresh"
startup_start = source.index("async function runLiveStartupTasks")
startup_end = source.index("function subscribeToNewBlocks", startup_start)
assert "maybeRefreshStakingSnapshot(true)" in source[startup_start:startup_end], "startup must refresh Staking independently"
repair_start = source.index("async function runRepairLoop")
repair_end = source.index("async function runLiveStartupTasks", repair_start)
assert "maybeRefreshStakingSnapshot()" in source[repair_start:repair_end], "repair loop must refresh Staking independently"
print("Staking/dashboard refresh decoupling checks passed")
PY

python3 - "$indexer_script" <<'PY'
import sys
from pathlib import Path
source = Path(sys.argv[1]).read_text(encoding="utf-8")
start = source.index("async function maybeRefreshStakingSnapshot")
end = source.index("function hydrateKnownServiceRegistry", start)
refresh = source[start:end]
reward_index = refresh.index("await refreshStakingSnapshot()")
scan_index = refresh.index("fetchObservedClientShares")
assert reward_index < scan_index, "reward refresh must complete before the large client-share scan starts"
print("Staking reward/share refresh ordering checks passed")
PY

staking_page="$(cd "$(dirname "$script")/.." && pwd)/app/staking/page.tsx"
if grep -Eq 'fetchLivePlans|fetch\(' "$staking_page"; then
  echo "staking page must not contain request-time upstream fetches" >&2
  exit 1
fi

ui_root="$(cd "$(dirname "$script")/.." && pwd)"
python3 - "$ui_root/app/globals.css" "$ui_root/app/revenue-calculator.tsx" "$ui_root/app/themed-select.tsx" "$ui_root/app/staking/staking-dashboard.tsx" <<'PY'
import sys
from pathlib import Path

css = Path(sys.argv[1]).read_text(encoding="utf-8")
calculator = Path(sys.argv[2]).read_text(encoding="utf-8")
select = Path(sys.argv[3]).read_text(encoding="utf-8")
staking = Path(sys.argv[4]).read_text(encoding="utf-8")
assert ".calculator-assumption-heading" in css and "grid-column: 1 / -1" in css, "calculator heading must span the assumption card"
assert calculator.count("calculator-assumption-heading") == 1, "calculator assumption must have one full-width heading row"
assert 'aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}' in select, "focused combobox must expose its active descendant"
assert 'role="listbox"' in select and 'role="option"' in select, "themed select must expose listbox semantics"
assert 'aria-label={scenario === "migrate" ? "Move suppliers to" : scenario === "new" ? "Public plan" : "Provider plan"}' in staking, "target plan accessible name must match its visible scenario label"
print("UI layout and accessibility contract checks passed")
PY

echo "production verifier warm-cache ordering passed"
