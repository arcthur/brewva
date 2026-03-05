#!/usr/bin/env bash

set -euo pipefail

root="${1:-skills}"

if [ ! -d "${root}" ]; then
  echo "error: directory not found: ${root}" >&2
  exit 1
fi

status=0
count=0

while IFS= read -r file; do
  count=$((count + 1))
  missing=()

  if ! grep -Eq '^---$' "${file}"; then
    missing+=("frontmatter")
  fi

  if ! grep -Eq '^outputs:' "${file}"; then
    missing+=("outputs_field")
  fi

  if ! grep -Eq '^consumes:' "${file}"; then
    missing+=("consumes_field")
  fi

  if ! grep -Eq '^tools:' "${file}"; then
    missing+=("tools_field")
  fi

  if ! grep -Eq '^budget:' "${file}"; then
    missing+=("budget_field")
  fi

  if ! grep -Eq '^[[:space:]]+required:' "${file}"; then
    missing+=("tools_required")
  fi

  if ! grep -Eq '^[[:space:]]+optional:' "${file}"; then
    missing+=("tools_optional")
  fi

  if ! grep -Eq '^[[:space:]]+denied:' "${file}"; then
    missing+=("tools_denied")
  fi

  if ! grep -Eq '^[[:space:]]+max_tool_calls:' "${file}"; then
    missing+=("budget_max_tool_calls")
  fi

  if ! grep -Eq '^[[:space:]]+max_tokens:' "${file}"; then
    missing+=("budget_max_tokens")
  fi

  if ! grep -Eq '^## (Intent|Objective)' "${file}"; then
    missing+=("intent_or_objective")
  fi

  if ! grep -Eq '^## Trigger' "${file}"; then
    missing+=("trigger")
  fi

  if ! grep -Eq '^## .*([Ww]orkflow|[Pp]rocedure|[Ss]equence|Mode Detection)' "${file}"; then
    missing+=("workflow")
  fi

  if ! grep -Eq '^## Stop Conditions' "${file}"; then
    missing+=("stop_conditions")
  fi

  if ! grep -Eq '^## Anti-Patterns' "${file}"; then
    missing+=("anti_patterns")
  fi

  if ! grep -Eq '^## Example' "${file}"; then
    missing+=("example")
  fi

  if [ "${#missing[@]}" -gt 0 ]; then
    status=1
    printf 'FAIL %s\n' "${file}"
    printf '  missing: %s\n' "${missing[*]}"
  else
    printf 'PASS %s\n' "${file}"
  fi
done < <(find "${root}" -type f -name 'SKILL.md' | sort)

echo "checked=${count}"

if [ "${status}" -ne 0 ]; then
  echo "result=fail"
  exit 1
fi

echo "result=pass"
