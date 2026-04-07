#!/usr/bin/env python3
"""Deterministic convergence outcome classifier for goal-loop iterations.

Input (JSON on stdin):
  {
    "metric_improved": bool,
    "delta": float,
    "min_delta": float,
    "guard_passed": bool | null,
    "execution_crashed": bool
  }

Output (JSON on stdout):
  {
    "outcome": "progress" | "guard_regression" | "below_noise_floor" | "no_improvement" | "crash",
    "reason": str
  }
"""

from __future__ import annotations

import json
import sys


def classify(
    metric_improved: bool,
    delta: float,
    min_delta: float,
    guard_passed: bool | None,
    execution_crashed: bool,
) -> dict[str, str]:
    if execution_crashed:
        return {"outcome": "crash", "reason": "Execution crashed before metric could be measured."}

    if not metric_improved:
        return {"outcome": "no_improvement", "reason": f"Metric did not improve (delta={delta})."}

    if guard_passed is False:
        return {"outcome": "guard_regression", "reason": "Metric improved but guard check failed."}

    if delta <= min_delta:
        return {
            "outcome": "below_noise_floor",
            "reason": f"Metric improved but delta {delta} <= min_delta {min_delta}.",
        }

    return {"outcome": "progress", "reason": f"Metric improved by {delta} (above min_delta {min_delta})."}


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON input: {exc}"}, sys.stdout)
        sys.exit(1)

    required = ["metric_improved", "delta", "min_delta", "guard_passed", "execution_crashed"]
    missing = [k for k in required if k not in data]
    if missing:
        json.dump({"error": f"Missing fields: {', '.join(missing)}"}, sys.stdout)
        sys.exit(1)

    result = classify(
        metric_improved=bool(data["metric_improved"]),
        delta=float(data["delta"]),
        min_delta=float(data["min_delta"]),
        guard_passed=data["guard_passed"],
        execution_crashed=bool(data["execution_crashed"]),
    )
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
