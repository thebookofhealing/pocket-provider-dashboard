#!/usr/bin/env python3
"""Validate the HTTP dashboard contract used by rollback-capable deploys."""

import json
import math
import sys
from typing import Mapping


def is_dashboard_ready(payload: Mapping[str, object]) -> bool:
    if payload.get("dashboardSchemaVersion") != 2:
        return False
    if payload.get("eligibleSupplierSnapshotSchemaVersion") != 2:
        return False
    if payload.get("eligibleSupplierSnapshotComplete") is not True:
        return False
    if not isinstance(payload.get("eligibleSupplierSnapshotFetchedAt"), str) or not payload["eligibleSupplierSnapshotFetchedAt"]:
        return False
    if not isinstance(payload.get("eligibleSupplierSnapshotStale"), bool):
        return False
    if not isinstance(payload.get("eligibleSupplierSnapshotSource"), str) or not payload["eligibleSupplierSnapshotSource"]:
        return False

    services = payload.get("services")
    if not isinstance(services, list) or not services:
        return False
    for service in services:
        if not isinstance(service, Mapping):
            return False
        count = service.get("eligibleSupplierCount")
        if isinstance(count, bool) or not isinstance(count, (int, float)) or not math.isfinite(count):
            return False
        fetched_at = service.get("eligibleSupplierCountFetchedAt")
        if not isinstance(fetched_at, str) or not fetched_at:
            return False
        if not isinstance(service.get("eligibleSupplierCountStale"), bool):
            return False
    return True


def is_dashboard_http_ready(status: int, payload: Mapping[str, object]) -> bool:
    return status == 200 and is_dashboard_ready(payload)


if __name__ == "__main__":
    try:
        value = json.load(sys.stdin)
        status = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    except (json.JSONDecodeError, OSError):
        raise SystemExit(1)
    except (TypeError, ValueError):
        raise SystemExit(1)
    raise SystemExit(0 if isinstance(value, Mapping) and is_dashboard_http_ready(status, value) else 1)
