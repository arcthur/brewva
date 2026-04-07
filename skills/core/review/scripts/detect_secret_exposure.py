#!/usr/bin/env python3
"""Detect hardcoded secrets or credential exposure in file content.

Input (JSON on stdin):
  {
    "files": [
      {"path": str, "content": str}
    ]
  }

Output (JSON on stdout):
  {
    "clean": bool,
    "findings": [
      {"path": str, "line": int, "pattern": str, "match": str}
    ]
  }

This is a security GATE, not a score. Any finding = blocked.
"""

from __future__ import annotations

import json
import re
import sys

SECRET_PATTERNS = [
    ("AWS_ACCESS_KEY", re.compile(r"(?:AKIA|ASIA)[A-Z0-9]{16}")),
    ("AWS_SECRET_KEY", re.compile(r"""(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}""")),
    ("GITHUB_TOKEN", re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}")),
    ("GENERIC_API_KEY", re.compile(r"""(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}""")),
    ("GENERIC_SECRET", re.compile(r"""(?:secret|password|passwd|token)\s*[=:]\s*['"]?[A-Za-z0-9_\-!@#$%^&*]{8,}['"]?""", re.IGNORECASE)),
    ("PRIVATE_KEY_HEADER", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("BEARER_TOKEN", re.compile(r"""(?:Bearer|Authorization)\s+[A-Za-z0-9_\-.]{20,}""")),
    ("CONNECTION_STRING", re.compile(r"""(?:mongodb|postgres|mysql|redis|amqp)://[^\s'"]{10,}""")),
    ("SLACK_TOKEN", re.compile(r"xox[bpoas]-[A-Za-z0-9\-]{10,}")),
    ("TELEGRAM_BOT_TOKEN", re.compile(r"\d{8,}:[A-Za-z0-9_\-]{35}")),
]

IGNORE_PATTERNS = [
    re.compile(r"^\s*#"),
    re.compile(r"^\s*//"),
    re.compile(r"process\.env\["),
    re.compile(r"process\.env\."),
    re.compile(r"\$\{[A-Z_]+\}"),
    re.compile(r"os\.environ"),
    re.compile(r"getenv\("),
    re.compile(r"EXAMPLE|PLACEHOLDER|REDACTED|CHANGEME|YOUR_", re.IGNORECASE),
]


def should_ignore_line(line: str) -> bool:
    return any(p.search(line) for p in IGNORE_PATTERNS)


def scan(files: list[dict]) -> dict:
    findings = []

    for file_entry in files:
        path = file_entry.get("path", "unknown")
        content = file_entry.get("content", "")

        for line_num, line in enumerate(content.split("\n"), start=1):
            if should_ignore_line(line):
                continue

            for pattern_name, pattern in SECRET_PATTERNS:
                match = pattern.search(line)
                if match:
                    matched_text = match.group(0)
                    redacted = matched_text[:8] + "..." if len(matched_text) > 8 else matched_text
                    findings.append({
                        "path": path,
                        "line": line_num,
                        "pattern": pattern_name,
                        "match": redacted,
                    })

    return {
        "clean": len(findings) == 0,
        "findings": findings,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"clean": False, "findings": [], "error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    files = data.get("files")
    if not isinstance(files, list):
        json.dump({"clean": False, "findings": [], "error": "files must be an array"}, sys.stdout)
        sys.exit(1)

    json.dump(scan(files), sys.stdout)


if __name__ == "__main__":
    main()
