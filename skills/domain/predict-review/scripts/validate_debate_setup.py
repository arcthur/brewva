#!/usr/bin/env python3
"""Validate debate setup conditions before running predict-review.

Input JSON (stdin):
  {
    "has_bounded_target": bool,
    "has_explicit_decision": bool,
    "perspective_count": int,
    "has_existing_evidence": bool
  }

Output JSON (stdout):
  {"ready": bool, "blocking": [str]}

Rules:
  - has_bounded_target must be true
  - has_explicit_decision must be true
  - perspective_count must be >= 2
  - has_existing_evidence must be true
  All must pass for ready=true.
"""

import json
import sys


def validate(data: dict) -> dict:
    blocking: list[str] = []

    required_bools = {
        "has_bounded_target": "Review target is not bounded — tighten scope before debating",
        "has_explicit_decision": "No explicit decision the debate should inform — name the decision",
        "has_existing_evidence": "No existing evidence to ground read-only judgment — gather evidence first",
    }

    for field, message in required_bools.items():
        value = data.get(field)
        if value is not True:
            blocking.append(message)

    perspective_count = data.get("perspective_count", 0)
    if not isinstance(perspective_count, int) or perspective_count < 2:
        blocking.append(
            f"Need at least 2 perspectives, got {perspective_count}"
        )

    return {"ready": len(blocking) == 0, "blocking": blocking}


def main() -> None:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        json.dump(
            {"ready": False, "blocking": [f"Invalid input JSON: {exc}"]},
            sys.stdout,
        )
        sys.exit(0)

    result = validate(data)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
