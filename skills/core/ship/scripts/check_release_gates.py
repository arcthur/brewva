#!/usr/bin/env python3
"""Deterministic release gate evaluation.

Input (JSON on stdin):
  {
    "review_state": "ready" | "needs_changes" | "blocked" | "missing",
    "qa_state": "pass" | "fail" | "inconclusive" | "missing",
    "ci_state": "green" | "red" | "unknown",
    "branch_state": "clean" | "dirty" | "diverged"
  }

Output (JSON on stdout):
  {
    "all_clear": bool,
    "gates": [{"name": str, "pass": bool, "detail": str}],
    "blocking": [str]
  }
"""

from __future__ import annotations

import json
import sys

GATE_SPECS = [
    {
        "name": "review",
        "field": "review_state",
        "pass_values": {"ready"},
        "details": {
            "ready": "Review approved",
            "needs_changes": "Review requires changes before merge",
            "blocked": "Review is blocked",
            "missing": "No review evidence found",
        },
    },
    {
        "name": "qa",
        "field": "qa_state",
        "pass_values": {"pass"},
        "details": {
            "pass": "QA passed with executable evidence",
            "fail": "QA found release-blocking failures",
            "inconclusive": "QA evidence incomplete",
            "missing": "No QA evidence found",
        },
    },
    {
        "name": "ci",
        "field": "ci_state",
        "pass_values": {"green"},
        "details": {
            "green": "CI pipeline green",
            "red": "CI pipeline has failures",
            "unknown": "CI status unknown or not yet run",
        },
    },
    {
        "name": "branch",
        "field": "branch_state",
        "pass_values": {"clean"},
        "details": {
            "clean": "Branch is clean and up to date",
            "dirty": "Branch has uncommitted or unstaged changes",
            "diverged": "Branch has diverged from target",
        },
    },
]


def check_gates(data: dict) -> dict:
    gates = []
    blocking = []

    for spec in GATE_SPECS:
        value = data.get(spec["field"], "missing")
        passed = value in spec["pass_values"]
        detail = spec["details"].get(value, f"Unknown state: {value}")
        gates.append({"name": spec["name"], "pass": passed, "detail": detail})
        if not passed:
            blocking.append(spec["name"])

    return {
        "all_clear": len(blocking) == 0,
        "gates": gates,
        "blocking": blocking,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    json.dump(check_gates(data), sys.stdout)


if __name__ == "__main__":
    main()
