#!/usr/bin/env python3
"""Check whether a proposed implementation approach is overly complex for what was requested.

Input JSON (stdin):
  {
    "estimated_line_count": int,
    "abstraction_count": int,
    "requested_features": ["feature A"],
    "proposed_features": ["feature A", "feature B (not asked)"]
  }

Output JSON (stdout):
  {
    "verdict": "acceptable" | "over_engineered",
    "speculative_features": ["feature B (not asked)"],
    "over_abstracted": bool,
    "flags": ["1 unrequested feature(s) proposed"]
  }

Exit code: 0 if acceptable, 1 if over_engineered or error.
"""

import json
import sys

# Flags a line count worth asking about — not a hard block, just a flag.
LINE_COUNT_WARN_THRESHOLD = 200

# Max new abstractions per requested feature before flagging over-abstraction.
ABSTRACTION_RATIO_THRESHOLD = 2


def check(data: dict) -> dict:
    line_count = data.get("estimated_line_count", 0)
    abstraction_count = data.get("abstraction_count", 0)
    requested = data.get("requested_features", [])
    proposed = data.get("proposed_features", [])

    if not isinstance(requested, list):
        requested = []
    if not isinstance(proposed, list):
        proposed = []

    requested_set = {str(f).strip().lower() for f in requested}
    speculative = [f for f in proposed if str(f).strip().lower() not in requested_set]

    flags: list[str] = []

    if speculative:
        flags.append(f"{len(speculative)} unrequested feature(s) proposed")

    max_abstractions = max(len(requested) * ABSTRACTION_RATIO_THRESHOLD, 1)
    over_abstracted = abstraction_count > max_abstractions
    if over_abstracted:
        flags.append(
            f"abstraction_count={abstraction_count} exceeds {max_abstractions} for {len(requested)} requested feature(s)"
        )

    if line_count > LINE_COUNT_WARN_THRESHOLD:
        flags.append(f"estimated_line_count={line_count} — verify this cannot be simpler")

    verdict = "over_engineered" if (speculative or over_abstracted) else "acceptable"

    return {
        "verdict": verdict,
        "speculative_features": speculative,
        "over_abstracted": over_abstracted,
        "flags": flags,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(
            {
                "verdict": "over_engineered",
                "speculative_features": [],
                "over_abstracted": False,
                "flags": [f"invalid JSON input: {exc}"],
            },
            sys.stdout,
        )
        sys.exit(1)

    result = check(data)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(0 if result["verdict"] == "acceptable" else 1)


if __name__ == "__main__":
    main()
