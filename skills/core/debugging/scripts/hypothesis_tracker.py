#!/usr/bin/env python3
"""Advisory format lint for the externalized debugging-hypothesis list.

The input is the model's own report, so the output is never independent
evidence, never a phase gate, and never an escalation authority (the
validator authority ceiling in skill-anatomy-v3). Counts are neutral
observations over a structurally valid list; they never decide whether an
investigation continues, stops, or escalates.

Input JSON (stdin):
  {
    "hypotheses": [
      {"id": int, "claim": str, "status": "active"|"falsified"|"confirmed", "evidence": str}
    ]
  }

Output JSON (stdout):
  {
    "valid": bool,
    "active_count": int,
    "falsified_count": int,
    "confirmed_count": int,
    "reason": str
  }
"""

import json
import sys

ALLOWED_STATUSES = {"active", "falsified", "confirmed"}


def invalid_result(
    reason: str,
    *,
    active_count: int = 0,
    falsified_count: int = 0,
    confirmed_count: int = 0,
) -> dict:
    return {
        "valid": False,
        "active_count": active_count,
        "falsified_count": falsified_count,
        "confirmed_count": confirmed_count,
        "reason": reason,
    }


def validate(data: object) -> dict:
    if not isinstance(data, dict):
        return invalid_result("input must be an object")

    hypotheses = data.get("hypotheses")
    if not isinstance(hypotheses, list):
        return invalid_result("hypotheses must be a list")

    seen_ids: set[int] = set()
    active_count = 0
    falsified_count = 0
    confirmed_count = 0
    errors: list[str] = []

    for i, h in enumerate(hypotheses):
        if not isinstance(h, dict):
            errors.append(f"hypothesis[{i}]: not a dict")
            continue

        hid = h.get("id")
        if type(hid) is not int:
            errors.append(f"hypothesis[{i}]: id must be int")
        elif hid in seen_ids:
            errors.append(f"hypothesis[{i}]: duplicate id {hid}")
        else:
            seen_ids.add(hid)

        claim = h.get("claim", "")
        if not isinstance(claim, str) or len(claim.strip()) == 0:
            errors.append(f"hypothesis[{i}]: claim must be non-empty string")

        status = h.get("status", "")
        if not isinstance(status, str) or status not in ALLOWED_STATUSES:
            errors.append(
                f"hypothesis[{i}]: status must be one of {sorted(ALLOWED_STATUSES)}"
            )
        elif status == "active":
            active_count += 1
        elif status == "falsified":
            falsified_count += 1
        elif status == "confirmed":
            confirmed_count += 1

        evidence = h.get("evidence", "")
        if status in ("falsified", "confirmed") and (
            not isinstance(evidence, str) or len(evidence.strip()) == 0
        ):
            errors.append(
                f"hypothesis[{i}]: {status} hypothesis must have non-empty evidence"
            )

    if errors:
        return invalid_result(
            "; ".join(errors),
            active_count=active_count,
            falsified_count=falsified_count,
            confirmed_count=confirmed_count,
        )

    return {
        "valid": True,
        "active_count": active_count,
        "falsified_count": falsified_count,
        "confirmed_count": confirmed_count,
        "reason": "ok",
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(invalid_result(f"invalid JSON input: {exc}"), sys.stdout)
        sys.exit(1)

    result = validate(data)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
