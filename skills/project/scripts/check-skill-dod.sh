#!/usr/bin/env bash

set -euo pipefail

root="${1:-skills}"

if [ ! -d "${root}" ]; then
  echo "error: directory not found: ${root}" >&2
  exit 1
fi

status=0
count=0
guidance_count=0

validate_project_guidance() {
  local file="$1"
  guidance_count=$((guidance_count + 1))

  local failures=()
  if ! sed -n '1p' "${file}" | grep -Eq '^---[[:space:]]*$'; then
    failures+=("frontmatter")
  fi
  if ! awk 'NR > 1 && /^---[[:space:]]*$/ { found = 1; exit } END { exit found ? 0 : 1 }' "${file}"; then
    failures+=("closing_frontmatter")
  fi

  local metadata
  metadata="$(awk 'NR == 1 { next } /^---[[:space:]]*$/ { exit } { print }' "${file}")"

  if ! printf '%s\n' "${metadata}" | grep -Eq '^strength: (invariant|workflow_gate|preference|lookup)$'; then
    failures+=("strength")
  fi
  if ! printf '%s\n' "${metadata}" | grep -Eq '^scope: [^[:space:]].*$'; then
    failures+=("scope")
  fi
  if ! printf '%s\n' "${metadata}" | grep -Eq '^convention_kind: (project_fact|user_preference|style_rule|workflow_rule|routing_rule|verification_rule|permission_rule|safety_boundary|compliance_rule)$'; then
    failures+=("convention_kind")
  fi
  if ! printf '%s\n' "${metadata}" | grep -Eq '^retirement_sensitivity: (auto_decay_allowed|review_only|non_retirable_without_owner|pinned)$'; then
    failures+=("retirement_sensitivity")
  fi
  if printf '%s\n' "${metadata}" | grep -Eq '^retirement_sensitivity: (non_retirable_without_owner|pinned)$' &&
    ! printf '%s\n' "${metadata}" | grep -Eq '^owner: [^[:space:]].*$'; then
    failures+=("owner")
  fi

  if printf '%s\n' "${metadata}" | grep -Evq '^(strength|scope|convention_kind|retirement_sensitivity|owner):|^[[:space:]]*$|^[[:space:]]*#'; then
    failures+=("unsupported_frontmatter_field")
  fi

  if [ "${#failures[@]}" -gt 0 ]; then
    status=1
    printf 'FAIL %s\n' "${file}"
    printf '  invalid project guidance metadata: %s\n' "${failures[*]}"
  else
    printf 'PASS %s (project guidance)\n' "${file}"
  fi
}

if [ -d "${root}/project/shared" ]; then
  while IFS= read -r file; do
    validate_project_guidance "${file}"
  done < <(find "${root}/project/shared" -maxdepth 1 -type f -name '*.md' | sort)
fi

while IFS= read -r file; do
  count=$((count + 1))
  missing=()
  removed=()

  if ! grep -Eq '^---$' "${file}"; then
    missing+=("frontmatter")
  fi

  if ! grep -Eq '^name: [^[:space:]].*$' "${file}"; then
    missing+=("name")
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

  for field in routing intent effects resources execution_hints consumes requires composable_with stability budget tools dispatch; do
    if grep -Eq "^${field}:" "${file}"; then
      removed+=("${field}")
    fi
  done

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
    if [ "${#removed[@]}" -gt 0 ]; then
      status=1
      printf 'FAIL %s\n' "${file}"
      printf '  removed SkillCard authority fields: %s\n' "${removed[*]}"
      continue
    fi
    if grep -Eiq '^(## )?(Hard Invariants|Workflow Gates|Build Baseline|Where To Look|Verification)$' "${file}"; then
      status=1
      printf 'FAIL %s\n' "${file}"
      printf '  overlay leak: global repo guidance belongs in skills/project/shared/*.md\n'
      continue
    fi
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

  if ! grep -Eq '^description: [^[:space:]].*$' "${file}"; then
    missing+=("description")
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

  if [ "${#removed[@]}" -gt 0 ]; then
    status=1
    printf 'FAIL %s\n' "${file}"
    printf '  removed SkillCard authority fields: %s\n' "${removed[*]}"
  elif [ "${#missing[@]}" -gt 0 ]; then
    status=1
    printf 'FAIL %s\n' "${file}"
    printf '  missing: %s\n' "${missing[*]}"
  else
    printf 'PASS %s\n' "${file}"
  fi
done < <(find "${root}" -type f -name 'SKILL.md' | sort)

echo "checked=${count}"
echo "project_guidance_checked=${guidance_count}"

if [ "${status}" -ne 0 ]; then
  echo "result=fail"
  exit 1
fi

echo "result=pass"
