#!/usr/bin/env bash
set -Eeuo pipefail

# This is deliberately a separate, non-rollback post-deploy check.  It validates
# the data contract exposed by the newly activated release without changing the
# current symlink or PM2 state.
LOCAL_BASE_URL="${LOCAL_BASE_URL:-http://127.0.0.1:3100}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://pocket-providers.kleomed.es/api/health}"
EXPECTED_SHA="${EXPECTED_SHA:-${GITHUB_SHA:-}}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch_with_retry() {
  local url="$1" output="$2"
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 20 "$url" >"$output"; then return 0; fi
    sleep 3
  done
  return 1
}

fetch_with_retry "$LOCAL_BASE_URL/api/dashboard?window=30d" "$TMP_DIR/dashboard.json"
fetch_with_retry "$LOCAL_BASE_URL/staking" "$TMP_DIR/staking.html"
# Fetch health last: the cold-process Staking request may warm its snapshot, so
# diagnostics must be read after that request rather than from the initial boot.
fetch_with_retry "$LOCAL_BASE_URL/api/health" "$TMP_DIR/health.json"

EXPECTED_SHA="$EXPECTED_SHA" python3 - "$TMP_DIR/health.json" "$TMP_DIR/dashboard.json" "$TMP_DIR/staking.html" <<'PY'
import json
import os
import sys

health = json.load(open(sys.argv[1], encoding="utf-8"))
dashboard = json.load(open(sys.argv[2], encoding="utf-8"))
staking = open(sys.argv[3], encoding="utf-8").read()
expected_sha = os.environ.get("EXPECTED_SHA", "")

diagnostics = health.get("diagnostics") or {}
eligible = diagnostics.get("eligibleSuppliers") or {}
materialized = diagnostics.get("dashboard") or {}
staking_diag = diagnostics.get("staking") or {}
indexer = health.get("indexer") or {}

assert eligible.get("schemaVersion") == 2 and eligible.get("complete") is True, "eligible supplier snapshot is not schema v2 complete"
assert eligible.get("knownServiceCount", 0) > 0, "service registry is empty"
assert eligible.get("knownServiceCount") == eligible.get("countedServiceCount"), "eligible snapshot is structurally incomplete"
assert materialized.get("schemaVersion") == 2, "dashboard materialization schema is not current"
assert materialized.get("eligibleSnapshotSchemaVersion") == 2 and materialized.get("eligibleSnapshotComplete") is True, "dashboard eligible snapshot metadata is invalid"
assert materialized.get("eligibleSnapshotSource") in ("indexer", "rest", "poktscan-graphql", "persisted-lkg"), "dashboard eligible snapshot source is missing"
assert materialized.get("serviceCount", 0) > 0 and materialized.get("eligibleCount") == materialized.get("serviceCount"), "dashboard services do not all contain eligible counts"
assert materialized.get("staleCount") == 0, "dashboard contains stale eligible counts"
assert indexer.get("isLocked") is True, "indexer lock is not held"

services = dashboard.get("services") or []
assert services, "30d dashboard has no services"
for service in services:
    assert isinstance(service.get("eligibleSupplierCount"), (int, float)), f"eligible count missing for {service.get('serviceId')}"
    assert service.get("eligibleSupplierCountStale") is False, f"eligible count stale for {service.get('serviceId')}"
top5 = materialized.get("top5") or []
assert top5 and all(isinstance(item.get("eligibleSupplierCount"), (int, float)) and item.get("eligibleSupplierCountStale") is False for item in top5), "dashboard top-five diagnostics are incomplete"

providers = staking_diag.get("providers") or []
assert any(provider.get("valueSource") in ("live-derived", "stale-derived", "provider-lkg") for provider in providers), "staking has no upstream-derived provider row"
assert "Live rewards" in staking or "Stale" in staking, "staking page did not render reward freshness state"

deployed_sha = diagnostics.get("deployedSha")
if expected_sha and deployed_sha:
    assert deployed_sha == expected_sha, f"local deployed SHA {deployed_sha} != expected {expected_sha}"

print(json.dumps({
    "deployedSha": deployed_sha,
    "dashboardServices": len(services),
    "eligibleServiceCount": eligible.get("knownServiceCount"),
    "liveDerivedProviders": sum(provider.get("valueSource") == "live-derived" for provider in providers),
    "indexerHeight": indexer.get("highestIngestedHeight")
}, sort_keys=True))
PY

# A public endpoint can be briefly ahead/behind CDN propagation.  Compare its
# SHA when it is reachable and exposes one; otherwise leave that optional check
# non-blocking while the local release contract remains mandatory.
if public_health="$(curl --fail --silent --show-error --max-time 10 "$PUBLIC_HEALTH_URL" 2>/dev/null)"; then
  PUBLIC_HEALTH="$public_health" EXPECTED_SHA="$EXPECTED_SHA" python3 - <<'PY'
import json, os
expected = os.environ.get("EXPECTED_SHA", "")
try:
    payload = json.loads(os.environ["PUBLIC_HEALTH"])
except Exception:
    raise SystemExit(0)
actual = ((payload.get("diagnostics") or {}).get("deployedSha"))
if expected and actual:
    if actual != expected:
        raise SystemExit(f"public deployed SHA {actual} != expected {expected}")
    print(f"public deployed SHA matches {expected}")
PY
fi
