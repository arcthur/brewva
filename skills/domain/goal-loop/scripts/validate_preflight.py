#!/usr/bin/env python3
"""Validate goal-loop preflight conditions before entering the loop.

Input (JSON on stdin):
  {
    "scope_resolves": bool,
    "cadence_explicit": bool,
    "metric_mechanical": bool,
    "guard_runnable": bool | null,
    "convergence_observable": bool,
    "escalation_concrete": bool,
    "baseline_recorded": bool
  }

Output (JSON on stdout):
  {
    "ready": bool,
    "checklist": [{"check": str, "pass": bool}],
    "blocking": [str]
  }

Fail-closed: missing required fields block preflight. Only guard_runnable
may be null (guard is optional).
"""

from __future__ import annotations

import json
import sys

REQUIRED_CHECKS = [
    ("scope_resolves", "Scope maps to real files or an explicit domain boundary"),
    ("cadence_explicit", "Next run timing and trigger mechanism are explicit"),
    ("metric_mechanical", "Metric source produces a parseable number"),
    ("convergence_observable", "Convergence predicate is objective and observable"),
    ("escalation_concrete", "Next owner on stuck/blocked is named explicitly"),
    ("baseline_recorded", "Baseline metric_observation fact is recorded"),
]

OPTIONAL_CHECKS = [
    ("guard_runnable", "Guard check (if present) can be executed"),
]


def validate(data: dict) -> dict:
    checklist = []
    blocking = []

    for field, description in REQUIRED_CHECKS:
        value = data.get(field)
        if value is None:
            checklist.append({"check": description, "pass": False})
            blocking.append(f"{description} (field '{field}' missing)")
        elif not bool(value):
            checklist.append({"check": description, "pass": False})
            blocking.append(description)
        else:
            checklist.append({"check": description, "pass": True})

    for field, description in OPTIONAL_CHECKS:
        value = data.get(field)
        if value is None:
            checklist.append({"check": description, "pass": True, "note": "guard not declared"})
        elif not bool(value):
            checklist.append({"check": description, "pass": False})
            blocking.append(description)
        else:
            checklist.append({"check": description, "pass": True})

    return {
        "ready": len(blocking) == 0,
        "checklist": checklist,
        "blocking": blocking,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}", "ready": False, "checklist": [], "blocking": ["invalid input"]}, sys.stdout)
        sys.exit(1)

    if not isinstance(data, dict):
        json.dump({"error": "Input must be a JSON object", "ready": False, "checklist": [], "blocking": ["invalid input"]}, sys.stdout)
        sys.exit(1)

    json.dump(validate(data), sys.stdout)


if __name__ == "__main__":
    main()
