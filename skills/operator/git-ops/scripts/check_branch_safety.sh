#!/usr/bin/env bash
set -euo pipefail

# Check branch safety before git mutations.
# Output JSON: {"safe": bool, "branch": str, "worktree_clean": bool,
#   "upstream_status": str, "diverged": bool, "warnings": [str]}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

warnings=()
safe=true

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '{"safe":false,"branch":"","worktree_clean":false,"upstream_status":"none","diverged":false,"warnings":["not inside a git work tree"]}\n'
  exit 0
fi

branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"

dirty_count="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "${dirty_count}" -gt 0 ]; then
  worktree_clean=false
  warnings+=("worktree has ${dirty_count} uncommitted change(s)")
else
  worktree_clean=true
fi

upstream="$(git rev-parse --abbrev-ref "${branch}@{upstream}" 2>/dev/null || echo "")"
if [ -z "${upstream}" ]; then
  upstream_status="no_upstream"
  diverged=false
  warnings+=("no upstream tracking branch configured")
else
  ahead="$(git rev-list --count "${upstream}..HEAD" 2>/dev/null || echo 0)"
  behind="$(git rev-list --count "HEAD..${upstream}" 2>/dev/null || echo 0)"

  if [ "${ahead}" -gt 0 ] && [ "${behind}" -gt 0 ]; then
    upstream_status="diverged"
    diverged=true
    safe=false
    warnings+=("branch diverged: ${ahead} ahead, ${behind} behind upstream")
  elif [ "${ahead}" -gt 0 ]; then
    upstream_status="ahead"
    diverged=false
  elif [ "${behind}" -gt 0 ]; then
    upstream_status="behind"
    diverged=false
    warnings+=("branch is ${behind} commit(s) behind upstream")
  else
    upstream_status="up_to_date"
    diverged=false
  fi
fi

if [ "${branch}" = "main" ] || [ "${branch}" = "master" ]; then
  warnings+=("on protected branch '${branch}' — history rewrite is dangerous")
  safe=false
fi

if [ "${branch}" = "DETACHED" ]; then
  warnings+=("HEAD is detached — commit carefully")
  safe=false
fi

warn_json="["
first=true
for w in "${warnings[@]+"${warnings[@]}"}"; do
  if [ "${first}" = true ]; then first=false; else warn_json+=","; fi
  warn_json+="\"$(json_escape "${w}")\""
done
warn_json+="]"

printf '{"safe":%s,"branch":"%s","worktree_clean":%s,"upstream_status":"%s","diverged":%s,"warnings":%s}\n' \
  "${safe}" \
  "$(json_escape "${branch}")" \
  "${worktree_clean}" \
  "${upstream_status}" \
  "${diverged}" \
  "${warn_json}"
