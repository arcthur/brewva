#!/usr/bin/env python3
"""Synthesize lane outcomes into a merge_decision.

Input (JSON on stdin):
  {
    "activated_lanes": [str],
    "lane_outcomes": [
      {
        "lane": str,
        "disposition": "clear" | "concern" | "blocked" | "inconclusive",
        "findings": [object] | null,
                "missingEvidence": [str] | null
      }
    ]
  }

Output (JSON on stdout):
  {
    "merge_decision": "ready" | "needs_changes" | "blocked",
    "rationale": str,
    "blocking_lanes": [str],
    "concern_lanes": [str],
    "missing_lanes": [str]
  }

Fail-closed: missing activated_lanes or unreported lanes → blocked.
"""

from __future__ import annotations

import json
import sys


def read_missing_evidence(outcome: dict) -> list[str]:
    value = outcome.get("missingEvidence")
    if value is None:
        value = outcome.get("missing_evidence")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def synthesize(activated_lanes: list[str], lane_outcomes: list[dict]) -> dict:
    blocking: list[str] = []
    concerns: list[str] = []
    inconclusive: list[str] = []

    reported = set()
    for outcome in lane_outcomes:
        lane = outcome.get("lane", "unknown")
        reported.add(lane)
        disposition = outcome.get("disposition", "inconclusive")
        has_missing = bool(read_missing_evidence(outcome))

        if disposition == "blocked":
            blocking.append(lane)
        elif disposition == "inconclusive" or (disposition == "clear" and has_missing):
            inconclusive.append(lane)
        elif disposition == "concern":
            concerns.append(lane)

    missing_lanes = sorted(set(activated_lanes) - reported)

    if missing_lanes:
        return {
            "merge_decision": "blocked",
            "rationale": f"lanes activated but never reported: {', '.join(missing_lanes)}",
            "blocking_lanes": blocking + inconclusive,
            "concern_lanes": concerns,
            "missing_lanes": missing_lanes,
        }

    if blocking or inconclusive:
        decision = "blocked"
        parts = []
        if blocking:
            parts.append(f"blocked by: {', '.join(blocking)}")
        if inconclusive:
            parts.append(f"inconclusive: {', '.join(inconclusive)}")
        rationale = "; ".join(parts)
    elif concerns:
        decision = "needs_changes"
        rationale = f"concerns in: {', '.join(concerns)}"
    else:
        decision = "ready"
        rationale = "all activated lanes clear without unresolved evidence gaps"

    return {
        "merge_decision": decision,
        "rationale": rationale,
        "blocking_lanes": blocking + inconclusive,
        "concern_lanes": concerns,
        "missing_lanes": [],
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    activated = data.get("activated_lanes")
    if not isinstance(activated, list) or not activated:
        json.dump(
            {
                "merge_decision": "blocked",
                "rationale": "activated_lanes is missing or empty — cannot synthesize without knowing which lanes were expected",
                "blocking_lanes": [],
                "concern_lanes": [],
                "missing_lanes": [],
                "error": "activated_lanes required",
            },
            sys.stdout,
        )
        sys.exit(1)

    outcomes = data.get("lane_outcomes")
    if not isinstance(outcomes, list):
        json.dump(
            {
                "merge_decision": "blocked",
                "rationale": "lane_outcomes is missing or not an array",
                "blocking_lanes": [],
                "concern_lanes": [],
                "missing_lanes": list(activated),
                "error": "lane_outcomes must be an array",
            },
            sys.stdout,
        )
        sys.exit(1)

    json.dump(synthesize(activated, outcomes), sys.stdout)


if __name__ == "__main__":
    main()
