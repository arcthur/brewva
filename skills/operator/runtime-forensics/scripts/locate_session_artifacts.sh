#!/usr/bin/env bash
set -euo pipefail

# Locate runtime artifacts for a session ID.
# Usage: locate_session_artifacts.sh <SESSION_ID> [WORKSPACE_ROOT]
# Output JSON: {"found": bool, "event_store": str|null, "ledger": str|null,
#   "projections": str|null, "wal": str|null, "session_index": str|null,
#   "session_index_snapshot": str|null}

if [ -z "${1:-}" ]; then
  printf '{"error":"SESSION_ID argument required"}\n'
  exit 1
fi

session_id="$1"
workspace="${2:-.}"

json_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
}

session_file_token() {
  printf '%s' "$1" | base64 | tr -d '\n' | tr '+/' '-_' | sed 's/=*$//'
}

encoded_session_id="$(session_file_token "${session_id}")"
event_store="null"
ledger="null"
projections="null"
wal="null"
session_index="null"
session_index_snapshot="null"
found=false

orchestrator_root="${workspace}/.orchestrator"
brewva_root="${workspace}/.brewva"

if [ -d "${orchestrator_root}" ]; then
  encoded_event_log="${orchestrator_root}/events/sess_${encoded_session_id}.jsonl"
  if [ -f "${encoded_event_log}" ]; then
    event_store="$(json_quote "${encoded_event_log}")"
    found=true
  fi

  ledger_path="${orchestrator_root}/ledger/evidence.jsonl"
  if [ -f "${ledger_path}" ]; then
    ledger="$(json_quote "${ledger_path}")"
  fi

  projection_path="${orchestrator_root}/projection"
  if [ -d "${projection_path}" ]; then
    projections="$(json_quote "${projection_path}")"
  fi

  runtime_wal_path="${orchestrator_root}/recovery-wal/runtime.jsonl"
  if [ -f "${runtime_wal_path}" ]; then
    wal="$(json_quote "${runtime_wal_path}")"
  fi
fi

if [ -d "${brewva_root}" ]; then
  index_path="${brewva_root}/session-index/session-index.duckdb"
  if [ -f "${index_path}" ]; then
    session_index="$(json_quote "${index_path}")"
  fi
  snapshot_manifest="${brewva_root}/session-index/read-snapshot.json"
  if [ -f "${snapshot_manifest}" ]; then
    session_index_snapshot="$(json_quote "${snapshot_manifest}")"
  fi
fi

search_dirs=("${orchestrator_root}" "${brewva_root}")

for root in "${search_dirs[@]}"; do
  [ -d "${root}" ] || continue

  candidate="${root}/sessions/${session_id}"
  if [ -d "${candidate}" ]; then
    if [ "${event_store}" = "null" ] && { [ -d "${candidate}/events" ] || [ -f "${candidate}/events.jsonl" ]; }; then
      es="${candidate}/events"
      [ -f "${candidate}/events.jsonl" ] && es="${candidate}/events.jsonl"
      event_store="$(json_quote "${es}")"
      found=true
    fi

    if [ "${ledger}" = "null" ] && { [ -f "${candidate}/ledger.json" ] || [ -f "${candidate}/ledger.jsonl" ]; }; then
      lf="${candidate}/ledger.json"
      [ -f "${candidate}/ledger.jsonl" ] && lf="${candidate}/ledger.jsonl"
      ledger="$(json_quote "${lf}")"
      found=true
    fi

    if [ "${projections}" = "null" ] && [ -d "${candidate}/projections" ]; then
      projections="$(json_quote "${candidate}/projections")"
      found=true
    fi

    if [ "${wal}" = "null" ] && ls "${candidate}"/wal* >/dev/null 2>&1; then
      wal_path="$(ls -1 "${candidate}"/wal* 2>/dev/null | head -1)"
      wal="$(json_quote "${wal_path}")"
      found=true
    fi
  fi

  # Also check flat layout: <base>/<artifact_type>/<session_id>*
  for evt_candidate in "${root}/events/${session_id}"*; do
    if [ -e "${evt_candidate}" ] && [ "${event_store}" = "null" ]; then
      event_store="$(json_quote "${evt_candidate}")"
      found=true
    fi
    break
  done

  for led_candidate in "${root}/ledger/${session_id}"*; do
    if [ -e "${led_candidate}" ] && [ "${ledger}" = "null" ]; then
      ledger="$(json_quote "${led_candidate}")"
      found=true
    fi
    break
  done

  for proj_candidate in "${root}/projections/${session_id}"*; do
    if [ -e "${proj_candidate}" ] && [ "${projections}" = "null" ]; then
      projections="$(json_quote "${proj_candidate}")"
      found=true
    fi
    break
  done

  for wal_candidate in "${root}/wal/${session_id}"*; do
    if [ -e "${wal_candidate}" ] && [ "${wal}" = "null" ]; then
      wal="$(json_quote "${wal_candidate}")"
      found=true
    fi
    break
  done
done

printf '{"found":%s,"event_store":%s,"ledger":%s,"projections":%s,"wal":%s,"session_index":%s,"session_index_snapshot":%s}\n' \
  "${found}" "${event_store}" "${ledger}" "${projections}" "${wal}" "${session_index}" "${session_index_snapshot}"
