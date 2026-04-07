#!/usr/bin/env bash
# parse_ci_state.sh — Parse current CI state for a branch/PR
# Input: PR_NUMBER as first argument
# Output JSON: {"failing_checks": [{"name":str,"conclusion":str}], "passing_count": int, "failing_count": int, "pending_count": int}
set -euo pipefail

json_error() {
  printf '{"error": "%s", "failing_checks": [], "passing_count": 0, "failing_count": 0, "pending_count": 0}\n' "$1"
  exit 1
}

if [ $# -lt 1 ]; then
  json_error "usage: parse_ci_state.sh <PR_NUMBER>"
fi

pr_number="$1"

if ! command -v gh &>/dev/null; then
  json_error "gh CLI not found"
fi

if ! gh auth status &>/dev/null; then
  json_error "gh not authenticated"
fi

checks_json=$(gh pr checks "$pr_number" --json name,conclusion,state 2>/dev/null) || json_error "failed to fetch checks for PR #${pr_number}"

if [ -z "$checks_json" ] || [ "$checks_json" = "[]" ]; then
  printf '{"failing_checks": [], "passing_count": 0, "failing_count": 0, "pending_count": 0}\n'
  exit 0
fi

passing_count=$(echo "$checks_json" | python3 -c "
import json, sys
checks = json.load(sys.stdin)
print(sum(1 for c in checks if c.get('conclusion') == 'SUCCESS'))
" 2>/dev/null || echo "0")

failing_checks=$(echo "$checks_json" | python3 -c "
import json, sys
checks = json.load(sys.stdin)
failing = [{'name': c['name'], 'conclusion': c.get('conclusion', c.get('state', 'UNKNOWN'))}
           for c in checks if c.get('conclusion') not in ('SUCCESS', None) or c.get('state') == 'FAILURE']
# Also include checks with no conclusion but non-pending state that indicates failure
result = [f for f in failing if f['conclusion'] not in ('SUCCESS', 'PENDING', 'QUEUED', None)]
print(json.dumps(result))
" 2>/dev/null || echo "[]")

failing_count=$(echo "$checks_json" | python3 -c "
import json, sys
checks = json.load(sys.stdin)
print(sum(1 for c in checks if c.get('conclusion') not in ('SUCCESS', 'PENDING', 'QUEUED', None) and c.get('conclusion') is not None))
" 2>/dev/null || echo "0")

pending_count=$(echo "$checks_json" | python3 -c "
import json, sys
checks = json.load(sys.stdin)
print(sum(1 for c in checks if c.get('conclusion') is None or c.get('conclusion') in ('PENDING', 'QUEUED')))
" 2>/dev/null || echo "0")

printf '{"failing_checks": %s, "passing_count": %s, "failing_count": %s, "pending_count": %s}\n' \
  "$failing_checks" "$passing_count" "$failing_count" "$pending_count"
