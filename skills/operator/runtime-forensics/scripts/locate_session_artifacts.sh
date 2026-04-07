#!/usr/bin/env bash
set -euo pipefail

# Locate runtime artifacts for a session ID.
# Usage: locate_session_artifacts.sh <SESSION_ID> [WORKSPACE_ROOT]
# Output JSON: {"found": bool, "event_store": str|null, "ledger": str|null,
#   "projections": str|null, "wal": str|null}

if [ -z "${1:-}" ]; then
  printf '{"error":"SESSION_ID argument required"}\n'
  exit 1
fi

session_id="$1"
workspace="${2:-.}"

event_store="null"
ledger="null"
projections="null"
wal="null"
found=false

search_dirs=(".orchestrator" ".brewva")

for base in "${search_dirs[@]}"; do
  root="${workspace}/${base}"
  [ -d "${root}" ] || continue

  candidate="${root}/sessions/${session_id}"
  if [ -d "${candidate}" ]; then
    if [ -d "${candidate}/events" ] || [ -f "${candidate}/events.jsonl" ]; then
      es="${candidate}/events"
      [ -f "${candidate}/events.jsonl" ] && es="${candidate}/events.jsonl"
      event_store="\"${es}\""
      found=true
    fi

    if [ -f "${candidate}/ledger.json" ] || [ -f "${candidate}/ledger.jsonl" ]; then
      lf="${candidate}/ledger.json"
      [ -f "${candidate}/ledger.jsonl" ] && lf="${candidate}/ledger.jsonl"
      ledger="\"${lf}\""
      found=true
    fi

    if [ -d "${candidate}/projections" ]; then
      projections="\"${candidate}/projections\""
      found=true
    fi

    if ls "${candidate}"/wal* >/dev/null 2>&1; then
      wal_path="$(ls -1 "${candidate}"/wal* 2>/dev/null | head -1)"
      wal="\"${wal_path}\""
      found=true
    fi
  fi

  # Also check flat layout: <base>/<artifact_type>/<session_id>*
  for evt_candidate in "${root}/events/${session_id}"*; do
    if [ -e "${evt_candidate}" ] && [ "${event_store}" = "null" ]; then
      event_store="\"${evt_candidate}\""
      found=true
    fi
    break
  done

  for led_candidate in "${root}/ledger/${session_id}"*; do
    if [ -e "${led_candidate}" ] && [ "${ledger}" = "null" ]; then
      ledger="\"${led_candidate}\""
      found=true
    fi
    break
  done

  for proj_candidate in "${root}/projections/${session_id}"*; do
    if [ -e "${proj_candidate}" ] && [ "${projections}" = "null" ]; then
      projections="\"${proj_candidate}\""
      found=true
    fi
    break
  done

  for wal_candidate in "${root}/wal/${session_id}"*; do
    if [ -e "${wal_candidate}" ] && [ "${wal}" = "null" ]; then
      wal="\"${wal_candidate}\""
      found=true
    fi
    break
  done
done

printf '{"found":%s,"event_store":%s,"ledger":%s,"projections":%s,"wal":%s}\n' \
  "${found}" "${event_store}" "${ledger}" "${projections}" "${wal}"
