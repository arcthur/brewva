#!/usr/bin/env python3
"""Validate and track debugging hypotheses.

Input JSON (stdin):
  {
    "hypotheses": [
      {"id": int, "claim": str, "status": "active"|"falsified"|"confirmed", "evidence": str}
    ],
    "max_active": int          # optional, defaults to 3
  }

Output JSON (stdout):
  {
    "valid": bool,
    "active_count": int,
    "should_escalate": bool,
    "reason": str
  }
"""

import json
import sys

HARD_MAX_ACTIVE = 3
ALLOWED_STATUSES = {"active", "falsified", "confirmed"}


def validate(data: dict) -> dict:
    hypotheses = data.get("hypotheses")
    if not isinstance(hypotheses, list):
        return {
            "valid": False,
            "active_count": 0,
            "should_escalate": False,
            "reason": "hypotheses must be a non-empty list",
        }

    max_active = data.get("max_active", HARD_MAX_ACTIVE)
    if not isinstance(max_active, int) or max_active < 1:
        max_active = HARD_MAX_ACTIVE
    max_active = min(max_active, HARD_MAX_ACTIVE)

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
        if not isinstance(hid, int):
            errors.append(f"hypothesis[{i}]: id must be int")
        elif hid in seen_ids:
            errors.append(f"hypothesis[{i}]: duplicate id {hid}")
        else:
            seen_ids.add(hid)

        claim = h.get("claim", "")
        if not isinstance(claim, str) or len(claim.strip()) == 0:
            errors.append(f"hypothesis[{i}]: claim must be non-empty string")

        status = h.get("status", "")
        if status not in ALLOWED_STATUSES:
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
        return {
            "valid": False,
            "active_count": active_count,
            "should_escalate": False,
            "reason": "; ".join(errors),
        }

    if active_count > max_active:
        return {
            "valid": False,
            "active_count": active_count,
            "should_escalate": False,
            "reason": f"active hypotheses ({active_count}) exceeds max ({max_active})",
        }

    all_falsified_at_cap = (
        falsified_count >= max_active
        and active_count == 0
        and confirmed_count == 0
    )

    if all_falsified_at_cap:
        return {
            "valid": True,
            "active_count": 0,
            "should_escalate": True,
            "reason": f"all {falsified_count} hypotheses falsified at max_active={max_active}; escalate instead of inventing more",
        }

    return {
        "valid": True,
        "active_count": active_count,
        "should_escalate": False,
        "reason": "ok",
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(
            {
                "valid": False,
                "active_count": 0,
                "should_escalate": False,
                "reason": f"invalid JSON input: {exc}",
            },
            sys.stdout,
        )
        sys.exit(1)

    result = validate(data)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
