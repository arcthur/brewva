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

  if ! grep -Eq '^intent:' "${file}"; then
    missing+=("intent_contract_field")
  fi

  if ! grep -Eq '^consumes:' "${file}"; then
    missing+=("consumes_field")
  fi

  if ! grep -Eq '^requires:' "${file}"; then
    missing+=("requires_field")
  fi

  if ! grep -Eq '^effects:' "${file}"; then
    missing+=("effects_field")
  fi

  if ! grep -Eq '^resources:' "${file}"; then
    missing+=("resources_field")
  fi

  if ! grep -Eq '^execution_hints:' "${file}"; then
    missing+=("execution_hints_field")
  fi

  if ! grep -Eq '^## (The Iron Law|Intent)' "${file}"; then
    missing+=("iron_law_or_intent")
  fi

  if ! grep -Eq '^## (Trigger|When to Use)' "${file}"; then
    missing+=("trigger")
  fi

  if ! grep -Eq '^## (Workflow|The Four Phases)' "${file}"; then
    missing+=("workflow")
  fi

  if ! grep -Eq '^## Stop Conditions' "${file}"; then
    missing+=("stop_conditions")
  fi

  if ! grep -Eq '^## (Anti-Patterns|Red Flags)' "${file}"; then
    missing+=("anti_patterns_or_red_flags")
  fi

  if ! grep -Eq '^## (Example|Concrete Example)' "${file}"; then
    missing+=("example")
  fi

  # Determine skill category and overlay status
  dir="$(dirname "${file}")"
  category=""
  is_overlay=false
  if echo "${dir}" | grep -q '/project/overlays/'; then
    is_overlay=true
  elif echo "${dir}" | grep -q '/core/'; then
    category="core"
  elif echo "${dir}" | grep -q '/domain/'; then
    category="domain"
  elif echo "${dir}" | grep -q '/operator/'; then
    category="operator"
  fi

  # Overlays are delta documents — skip v2-specific checks
  if [ "${is_overlay}" = true ]; then
    if [ "${#missing[@]}" -gt 0 ]; then
      # For overlays, only fail on truly missing structural sections
      overlay_missing=()
      for m in "${missing[@]}"; do
        case "${m}" in
          frontmatter|workflow|stop_conditions|anti_patterns_or_red_flags) overlay_missing+=("${m}") ;;
        esac
      done
      if [ "${#overlay_missing[@]}" -gt 0 ]; then
        status=1
        printf 'FAIL %s\n' "${file}"
        printf '  missing: %s\n' "${overlay_missing[*]}"
      else
        printf 'PASS %s (overlay)\n' "${file}"
      fi
    else
      printf 'PASS %s (overlay)\n' "${file}"
    fi
    continue
  fi

  if [ "${category}" = "core" ] || [ "${category}" = "domain" ]; then
    if ! grep -Eq '^## The Iron Law' "${file}"; then
      missing+=("iron_law_v2")
    fi
  fi

  # v2 check: Red Flags section for core and domain skills
  if [ "${category}" = "core" ] || [ "${category}" = "domain" ]; then
    if ! grep -Eq '^## Red Flags' "${file}"; then
      missing+=("red_flags_v2")
    fi
  fi

  # v2 check: scripts/ directory should exist for domain and operator skills
  # that have conditional/deterministic logic (check if scripts field in frontmatter)
  if [ "${category}" = "domain" ] || [ "${category}" = "operator" ]; then
    if grep -Eq '^scripts:' "${file}"; then
      skill_dir="$(dirname "${file}")"
      if [ ! -d "${skill_dir}/scripts" ]; then
        missing+=("scripts_directory_missing")
      fi
    fi
  fi

  # v2 check: Example section must have substantial content (at least 5 lines after header)
  example_lines=0
  if grep -Eq '^## (Example|Concrete Example)' "${file}"; then
    example_lines=$(sed -n '/^## \(Example\|Concrete Example\)/,/^## /p' "${file}" | tail -n +2 | head -n -1 | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
  fi
  if [ "${example_lines}" -lt 5 ] 2>/dev/null; then
    missing+=("example_too_short")
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
