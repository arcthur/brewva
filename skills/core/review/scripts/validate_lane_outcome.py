#!/usr/bin/env python3
"""Validate a single review lane outcome against the canonical child schema.

Input (JSON on stdin): a single lane outcome object.
Output (JSON on stdout):
  {
    "valid": bool,
    "errors": [str]
  }

Canonical child fields:
  - lane (str, required)
  - disposition ("clear" | "concern" | "blocked" | "inconclusive", required)
  - primaryClaim (str, required)
  - findings ([object], required when disposition != "clear")
  - missingEvidence ([str], optional)
  - openQuestions ([str], optional)
  - strongestCounterpoint (str, optional)
  - confidence (number 0-1 or str, optional)

Compatibility aliases accepted on input:
    - primary_claim -> primaryClaim
    - missing_evidence -> missingEvidence
    - open_questions -> openQuestions
    - strongest_counterpoint -> strongestCounterpoint

Fail-closed: missing required fields or invalid disposition = invalid.
"""

from __future__ import annotations

import json
import sys

REQUIRED_FIELDS = {"lane", "disposition", "primaryClaim"}
VALID_DISPOSITIONS = {"clear", "concern", "blocked", "inconclusive"}
FIELD_ALIASES = {
    "primary_claim": "primaryClaim",
    "missing_evidence": "missingEvidence",
    "open_questions": "openQuestions",
    "strongest_counterpoint": "strongestCounterpoint",
}


def canonicalize(outcome: dict) -> tuple[dict, list[str]]:
    normalized = dict(outcome)
    errors: list[str] = []

    for alias, canonical in FIELD_ALIASES.items():
        if alias not in outcome:
            continue
        if canonical in outcome and outcome[canonical] != outcome[alias]:
            errors.append(
                f"Conflicting field values for '{canonical}' and compatibility alias '{alias}'"
            )
            continue
        normalized.setdefault(canonical, outcome[alias])

    return normalized, errors


def validate_string_list(value: object, field: str, errors: list[str]) -> None:
    if not isinstance(value, list):
        errors.append(f"{field} must be an array")
        return
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{field}[{index}] must be a non-empty string")


def validate(outcome: dict) -> dict:
    normalized, errors = canonicalize(outcome)

    for field in REQUIRED_FIELDS:
        if field not in normalized:
            errors.append(f"Missing required field: {field}")
        elif not isinstance(normalized[field], str) or not normalized[field].strip():
            errors.append(f"Field '{field}' must be a non-empty string")

    disposition = normalized.get("disposition")
    if isinstance(disposition, str) and disposition not in VALID_DISPOSITIONS:
        errors.append(
            f"disposition '{disposition}' not in {sorted(VALID_DISPOSITIONS)}"
        )

    if isinstance(disposition, str) and disposition != "clear":
        findings = normalized.get("findings")
        if findings is None or (isinstance(findings, list) and len(findings) == 0):
            errors.append(
                f"disposition is '{disposition}' but findings is empty or missing — "
                "non-clear lanes must report at least one finding"
            )

    if "findings" in normalized and not isinstance(normalized["findings"], list):
        errors.append("findings must be an array")

    if "missingEvidence" in normalized:
        validate_string_list(normalized["missingEvidence"], "missingEvidence", errors)

    if "openQuestions" in normalized:
        validate_string_list(normalized["openQuestions"], "openQuestions", errors)

    if "strongestCounterpoint" in normalized and (
        not isinstance(normalized["strongestCounterpoint"], str)
        or not normalized["strongestCounterpoint"].strip()
    ):
        errors.append("strongestCounterpoint must be a non-empty string")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"valid": False, "errors": [f"Invalid JSON: {exc}"]}, sys.stdout)
        sys.exit(1)

    if isinstance(data, list):
        results = []
        all_valid = True
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                results.append({"valid": False, "errors": [f"Item {i} is not an object"]})
                all_valid = False
            else:
                r = validate(item)
                results.append(r)
                if not r["valid"]:
                    all_valid = False
        json.dump({"all_valid": all_valid, "results": results}, sys.stdout)
    elif isinstance(data, dict):
        json.dump(validate(data), sys.stdout)
    else:
        json.dump({"valid": False, "errors": ["Input must be a JSON object or array"]}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
