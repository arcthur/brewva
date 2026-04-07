#!/usr/bin/env python3
"""Validate a loop_contract JSON against the required schema.

Input (JSON on stdin): the loop_contract object.
Output (JSON on stdout):
  {
    "valid": bool,
    "missing_fields": [str],
    "type_errors": [str],
    "warnings": [str]
  }

Fail-closed: missing required fields and metric sub-field violations
are errors, not warnings. Type mismatches are errors.
"""

from __future__ import annotations

import json
import sys

REQUIRED_FIELDS: dict[str, type | tuple[type, ...]] = {
    "goal": str,
    "scope": list,
    "cadence": dict,
    "continuity_mode": str,
    "loop_key": str,
    "baseline": dict,
    "metric": dict,
    "convergence_condition": dict,
    "max_runs": (int, float),
    "escalation_policy": dict,
}

VALID_CONTINUITY_MODES = {"inherit", "fresh"}

METRIC_REQUIRED = {"key", "direction", "unit"}
VALID_DIRECTIONS = {"up", "down"}


def validate(contract: dict) -> dict:
    missing: list[str] = []
    type_errors: list[str] = []
    warnings: list[str] = []

    for field, expected_type in REQUIRED_FIELDS.items():
        if field not in contract:
            missing.append(field)
        elif not isinstance(contract[field], expected_type):
            type_errors.append(
                f"Field '{field}' expected {expected_type}, got {type(contract[field]).__name__}"
            )

    if "continuity_mode" in contract and contract["continuity_mode"] not in VALID_CONTINUITY_MODES:
        type_errors.append(
            f"continuity_mode '{contract['continuity_mode']}' not in {sorted(VALID_CONTINUITY_MODES)}"
        )

    if "metric" in contract and isinstance(contract["metric"], dict):
        metric = contract["metric"]
        for mk in METRIC_REQUIRED:
            if mk not in metric:
                missing.append(f"metric.{mk}")
        if "direction" in metric and metric["direction"] not in VALID_DIRECTIONS:
            type_errors.append(
                f"metric.direction '{metric['direction']}' not in {sorted(VALID_DIRECTIONS)}"
            )

    if "max_runs" in contract:
        val = contract["max_runs"]
        if isinstance(val, (int, float)) and val < 1:
            type_errors.append("max_runs must be >= 1")

    if "scope" in contract and isinstance(contract["scope"], list) and len(contract["scope"]) == 0:
        warnings.append("scope is empty — loop has no file or domain boundary")

    return {
        "valid": len(missing) == 0 and len(type_errors) == 0,
        "missing_fields": missing,
        "type_errors": type_errors,
        "warnings": warnings,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(
            {"valid": False, "missing_fields": [], "type_errors": [], "warnings": [], "error": f"Invalid JSON: {exc}"},
            sys.stdout,
        )
        sys.exit(1)

    if not isinstance(data, dict):
        json.dump(
            {"valid": False, "missing_fields": [], "type_errors": [], "warnings": [], "error": "Input must be a JSON object"},
            sys.stdout,
        )
        sys.exit(1)

    json.dump(validate(data), sys.stdout)


if __name__ == "__main__":
    main()
