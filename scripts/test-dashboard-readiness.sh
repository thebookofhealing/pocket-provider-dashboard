#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
python3 - "$script_dir" <<'PY'
import sys
from pathlib import Path

script_dir = Path(sys.argv[1])
sys.path.insert(0, str(script_dir))
from dashboard_readiness import is_dashboard_http_ready, is_dashboard_ready

base = {
    "dashboardSchemaVersion": 2,
    "eligibleSupplierSnapshotSchemaVersion": 2,
    "eligibleSupplierSnapshotComplete": True,
    "eligibleSupplierSnapshotFetchedAt": "2026-09-29T12:00:00Z",
    "eligibleSupplierSnapshotStale": True,
    "eligibleSupplierSnapshotSource": "persisted-lkg",
    "services": [{
        "serviceId": "eth",
        "eligibleSupplierCount": 0,
        "eligibleSupplierCountFetchedAt": "2026-09-29T11:00:00Z",
        "eligibleSupplierCountStale": True,
    }],
}

assert is_dashboard_ready(base), "a complete stale LKG dashboard remains HTTP-ready"
assert is_dashboard_http_ready(200, base), "HTTP 200 complete dashboard passes deployment readiness"
assert not is_dashboard_http_ready(202, base), "HTTP 202 warming response must fail deployment readiness"
assert not is_dashboard_ready({**base, "services": []}), "empty dashboard must fail readiness"
assert not is_dashboard_ready({**base, "eligibleSupplierSnapshotComplete": False}), "incomplete snapshot must fail readiness"
assert not is_dashboard_ready({**base, "services": [{**base["services"][0], "eligibleSupplierCount": None}]}), "missing eligible count must fail readiness"
print("dashboard readiness tests passed")
PY
