#!/usr/bin/env python3
"""Shared deployment-readiness predicate for the durable Staking snapshot."""

import json
import sys
from typing import Iterable, Mapping


def is_staking_v3_ready(payload: Mapping[str, object]) -> bool:
    diagnostics = payload.get("diagnostics")
    if not isinstance(diagnostics, Mapping):
        return False
    staking = diagnostics.get("staking")
    if not isinstance(staking, Mapping):
        return False
    return staking.get("persisted") is True and staking.get("snapshotSchemaVersion") == 3


def wait_for_staking_v3(samples: Iterable[Mapping[str, object]], max_attempts: int = 30) -> bool:
    for index, sample in enumerate(samples):
        if index >= max_attempts:
            break
        if is_staking_v3_ready(sample):
            return True
    return False


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        raise SystemExit(1)
    raise SystemExit(0 if is_staking_v3_ready(payload) else 1)
