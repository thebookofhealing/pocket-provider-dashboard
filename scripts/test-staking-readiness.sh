#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
python3 - "$script_dir" <<'PY'
import sys
from pathlib import Path

script_dir = Path(sys.argv[1])
sys.path.insert(0, str(script_dir))
from staking_readiness import is_staking_v3_ready, wait_for_staking_v3

legacy = {"diagnostics": {"staking": {"persisted": True, "snapshotSchemaVersion": 2}}}
ready = {"diagnostics": {"staking": {"persisted": True, "snapshotSchemaVersion": 3}}}
missing = {"diagnostics": {"staking": {"persisted": False, "snapshotSchemaVersion": None}}}

assert not is_staking_v3_ready(legacy), "legacy v2 must not satisfy v3 readiness"
assert is_staking_v3_ready(ready), "persisted v3 must satisfy readiness"
assert wait_for_staking_v3([legacy, missing, ready], max_attempts=3), "readiness should succeed when v3 appears within the bounded window"
assert not wait_for_staking_v3([legacy, missing, legacy], max_attempts=3), "readiness should fail when v3 never appears"
print("staking v3 readiness tests passed")
PY
