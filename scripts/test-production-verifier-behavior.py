#!/usr/bin/env python3
"""Exercise the production verifier's live-derived-provider gate end to end.

The verifier is intentionally run against a deterministic local HTTP fixture so
this test covers the same shell/Python path used after deployment without
depending on an upstream indexer or a production VM.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
VERIFY_SCRIPT = REPO_ROOT / "scripts" / "verify-production-data.sh"


def make_payload(live_derived: bool) -> tuple[dict, dict, str]:
    provider_ids = (
        "kleomedes-public",
        "kalorius-public",
        "nodefleet-public",
        "purroofgroup-public",
        "easy2stake-public",
    )
    def provider_name(provider_id: str) -> str:
        return provider_id[: -len("-public")]

    providers = [
        {
            "id": provider_id,
            "provider": provider_name(provider_id),
            "domain": f"{provider_name(provider_id)}.example",
            "rewardDomain": f"{provider_name(provider_id)}.example",
            "status": "live" if live_derived else "stale",
            "valueSource": "live-derived" if live_derived else "provider-lkg",
            "sourceUpdatedAt": "2026-10-17T19:00:00.000Z",
            "fetchedAt": "2026-10-17T19:01:00.000Z",
            "clientShareStatus": "uniform",
            "clientShareSource": "configured-fallback",
            "clientShareObservedAt": "2026-10-17T19:01:00.000Z",
            "activeConfigCount": 0,
            "ownerRevShareMatchCount": 0,
            "reason": None,
        }
        for provider_id in provider_ids
    ]
    service = {
        "serviceId": "svc-test",
        "eligibleSupplierCount": 1,
        "eligibleSupplierCountFetchedAt": "2026-10-17T19:01:00.000Z",
        "eligibleSupplierCountStale": False,
    }
    dashboard = {
        "services": [service],
    }
    health = {
        "diagnostics": {
            "eligibleSuppliers": {
                "schemaVersion": 2,
                "complete": True,
                "knownServiceCount": 1,
                "countedServiceCount": 1,
            },
            "dashboard": {
                "schemaVersion": 2,
                "eligibleSnapshotSchemaVersion": 2,
                "eligibleSnapshotComplete": True,
                "eligibleSnapshotSource": "indexer",
                "serviceCount": 1,
                "eligibleCount": 1,
                "staleCount": 0,
                "top5": [service],
            },
            "staking": {
                "snapshotSchemaVersion": 3,
                "persisted": True,
                "providers": providers,
            },
            "deployedSha": None,
        },
        "indexer": {
            "isLocked": True,
            "highestIngestedHeight": 100,
        },
    }
    return health, dashboard, "<html>Live rewards</html>"


class FixtureHandler(BaseHTTPRequestHandler):
    health, dashboard, staking = make_payload(False)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path
        if path == "/api/health":
            body = self.health
        elif path == "/api/dashboard":
            body = self.dashboard
        elif path == "/staking":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(self.staking.encode("utf-8"))
            return
        else:
            self.send_error(404)
            return

        payload = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: object) -> None:
        return


def run_verifier(base_url: str, allow_degraded: bool) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "LOCAL_BASE_URL": base_url,
            "PUBLIC_HEALTH_URL": f"{base_url}/api/health",
            "EXPECTED_SHA": "",
            "GITHUB_SHA": "",
        }
    )
    if allow_degraded:
        environment["ALLOW_UPSTREAM_STAKING_DEGRADED"] = "true"
    else:
        environment.pop("ALLOW_UPSTREAM_STAKING_DEGRADED", None)
    return subprocess.run(
        ["bash", str(VERIFY_SCRIPT)],
        cwd=REPO_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def assert_result(result: subprocess.CompletedProcess[str], expected: bool, label: str) -> None:
    if (result.returncode == 0) != expected:
        print(f"{label} failed with exit {result.returncode}", file=sys.stderr)
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(1)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        # Zero live-derived providers must fail closed without an explicit outage acknowledgement.
        FixtureHandler.health, FixtureHandler.dashboard, FixtureHandler.staking = make_payload(False)
        rejected = run_verifier(base_url, allow_degraded=False)
        assert_result(rejected, expected=False, label="zero-live default rejection")
        if "no live-derived provider economics" not in rejected.stderr:
            raise AssertionError("zero-live rejection did not report the live-derived gate")

        # The same degraded fixture may pass only when the explicit override is set.
        acknowledged = run_verifier(base_url, allow_degraded=True)
        assert_result(acknowledged, expected=True, label="explicit degraded override")

        # A healthy fixture passes without requiring the override.
        FixtureHandler.health, FixtureHandler.dashboard, FixtureHandler.staking = make_payload(True)
        healthy = run_verifier(base_url, allow_degraded=False)
        assert_result(healthy, expected=True, label="live-derived provider success")
    finally:
        server.shutdown()
        thread.join(timeout=5)

    print("production verifier live-derived gate behavior passed")


if __name__ == "__main__":
    main()
