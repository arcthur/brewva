#!/usr/bin/env bash
# check_loop_safety.sh — Verify loop safety gate items before continuing a CI iteration
# Input: JSON on stdin with fields:
#   target_pr (int|null), failing_evidence_current (bool),
#   next_verification_step (str|null), stop_condition (str|null), is_design_drift (bool)
# Output JSON: {"safe_to_continue": bool, "blocking": [str]}
set -euo pipefail

json_error() {
  printf '{"error": "%s", "safe_to_continue": false, "blocking": ["internal error"]}\n' "$1"
  exit 1
}

if ! command -v python3 &>/dev/null; then
  json_error "python3 not found"
fi

input=$(cat)

if [ -z "$input" ]; then
  json_error "no input provided on stdin"
fi

echo "$input" | python3 -c "
import json, sys

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(json.dumps({'error': f'invalid JSON: {e}', 'safe_to_continue': False, 'blocking': ['invalid input JSON']}))
    sys.exit(0)

blocking = []

if not data.get('target_pr'):
    blocking.append('target PR/branch is not explicit')

if not data.get('failing_evidence_current', False):
    blocking.append('failing evidence is not current — refresh before retrying')

if not data.get('next_verification_step'):
    blocking.append('next verification step is not concrete')

if not data.get('stop_condition'):
    blocking.append('stop condition for this run is not explicit')

if data.get('is_design_drift', False):
    blocking.append('problem has drifted from CI iteration into design territory — route to design or debugging')

safe = len(blocking) == 0
print(json.dumps({'safe_to_continue': safe, 'blocking': blocking}))
"
