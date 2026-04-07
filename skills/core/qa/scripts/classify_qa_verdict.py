#!/usr/bin/env python3
"""Deterministic QA verdict classification based on execution evidence.

Input (JSON on stdin):
  {
    "checks_executed": int,
        "failed_checks": int | [object],
    "adversarial_attempted": bool,
        "required_evidence_covered": bool,
        "missing_required_evidence": int | [str],
    "environment_reachable": bool
  }

Output (JSON on stdout):
  {
    "verdict": "pass" | "fail" | "inconclusive",
    "reason": str
  }
"""

from __future__ import annotations

import json
import sys


def _count(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    if isinstance(value, list):
        return len(value)
    return 0


def _read_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return default


def classify(data: dict) -> dict:
    checks = _count(data.get("checks_executed", 0))
    failed_checks = _count(data.get("failed_checks", 0))
    adversarial = _read_bool(data.get("adversarial_attempted", False))
    env_reachable = _read_bool(data.get("environment_reachable", False))

    missing_required_evidence = _count(data.get("missing_required_evidence", 0))
    if data.get("required_evidence_covered") is False:
        missing_required_evidence = max(missing_required_evidence, 1)

    if not env_reachable:
        return {"verdict": "inconclusive", "reason": "environment not reachable"}

    if checks == 0:
        return {"verdict": "inconclusive", "reason": "no checks executed"}

    if failed_checks > 0:
        plural = "s" if failed_checks != 1 else ""
        return {"verdict": "fail", "reason": f"{failed_checks} check{plural} failed"}

    if missing_required_evidence > 0:
        plural = "s" if missing_required_evidence != 1 else ""
        return {
            "verdict": "inconclusive",
            "reason": f"{missing_required_evidence} required evidence item{plural} missing",
        }

    if not adversarial:
        return {
            "verdict": "inconclusive",
            "reason": "no adversarial probe attempted; evidence incomplete",
        }

    return {"verdict": "pass", "reason": "all checks passed with adversarial coverage"}


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    json.dump(classify(data), sys.stdout)


if __name__ == "__main__":
    main()
