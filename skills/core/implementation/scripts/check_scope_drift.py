#!/usr/bin/env python3
"""Check whether files changed during implementation stay within declared targets.

Input JSON (stdin):
  {
    "implementation_targets": ["packages/foo/src/bar.ts", "packages/foo/src/"],
    "files_changed": ["packages/foo/src/bar.ts", "packages/foo/src/baz.ts", "packages/qux/README.md"]
  }

Output JSON (stdout):
  {
    "within_scope": bool,
    "drifted_files": ["packages/qux/README.md"],
    "target_coverage": 0.67
  }
"""

import json
import sys


def normalize(path: str) -> str:
    return path.rstrip("/")


def is_covered(file_path: str, targets: list[str]) -> bool:
    """Return True if file_path matches or is under any target."""
    norm = normalize(file_path)
    for t in targets:
        nt = normalize(t)
        if norm == nt or norm.startswith(nt + "/"):
            return True
    return False


def check(data: dict) -> dict:
    targets = data.get("implementation_targets")
    changed = data.get("files_changed")

    if not isinstance(targets, list) or not targets:
        return {
            "within_scope": False,
            "drifted_files": [],
            "target_coverage": 0.0,
            "error": "implementation_targets must be a non-empty list",
        }

    if not isinstance(changed, list):
        return {
            "within_scope": False,
            "drifted_files": [],
            "target_coverage": 0.0,
            "error": "files_changed must be a list — fail-closed on malformed input",
        }

    if not changed:
        return {
            "within_scope": True,
            "drifted_files": [],
            "target_coverage": 0.0,
        }

    drifted: list[str] = []
    covered_count = 0

    for f in changed:
        if not isinstance(f, str):
            continue
        if is_covered(f, targets):
            covered_count += 1
        else:
            drifted.append(f)

    total = len(changed)
    coverage = covered_count / total if total > 0 else 0.0

    return {
        "within_scope": len(drifted) == 0,
        "drifted_files": sorted(drifted),
        "target_coverage": round(coverage, 2),
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(
            {
                "within_scope": False,
                "drifted_files": [],
                "target_coverage": 0.0,
                "error": f"invalid JSON input: {exc}",
            },
            sys.stdout,
        )
        sys.exit(1)

    result = check(data)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(0 if result["within_scope"] else 1)


if __name__ == "__main__":
    main()
