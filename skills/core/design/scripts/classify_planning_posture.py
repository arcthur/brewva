#!/usr/bin/env python3
"""Deterministic planning posture classification based on change scope.

Input (JSON on stdin):
  {
    "affected_paths_count": int,
    "boundaries_crossed": int,
    "has_public_surface": bool,
    "has_persisted_format": bool,
    "has_security_surface": bool
  }

Output (JSON on stdout):
  {
    "posture": "trivial" | "moderate" | "complex" | "high_risk",
    "reason": str
  }
"""

from __future__ import annotations

import json
import sys


def classify(data: dict) -> dict:
    affected = data.get("affected_paths_count", 0)
    boundaries = data.get("boundaries_crossed", 0)
    has_public = data.get("has_public_surface", False)
    has_persisted = data.get("has_persisted_format", False)
    has_security = data.get("has_security_surface", False)

    if has_public or has_persisted or has_security:
        reasons = []
        if has_public:
            reasons.append("public surface affected")
        if has_persisted:
            reasons.append("persisted format affected")
        if has_security:
            reasons.append("security surface affected")
        return {"posture": "high_risk", "reason": "; ".join(reasons)}

    if boundaries > 1 or affected > 5:
        parts = []
        if boundaries > 1:
            parts.append(f"crosses {boundaries} boundaries")
        if affected > 5:
            parts.append(f"{affected} paths affected")
        return {"posture": "complex", "reason": "; ".join(parts)}

    if affected > 1:
        return {"posture": "moderate", "reason": f"{affected} paths affected"}

    return {"posture": "trivial", "reason": "single path, no boundary or surface risk"}


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    json.dump(classify(data), sys.stdout)


if __name__ == "__main__":
    main()
