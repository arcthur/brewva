#!/usr/bin/env bash
# Brewva Learning Review / Audit
# Summarizes pending items across all learning files and identifies promotion candidates.
# Usage: ./review.sh [--full]

set -euo pipefail

LEARNINGS_DIR="./.brewva/learnings"
CANDIDATES_DIR="$LEARNINGS_DIR/candidates"

# Auto-init learnings dir if missing
if [ ! -d "$LEARNINGS_DIR" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    bash "$SCRIPT_DIR/setup.sh" 2>/dev/null || mkdir -p "$LEARNINGS_DIR"
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

FULL=false
if [[ "${1:-}" == "--full" ]]; then
    FULL=true
fi

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Brewva Learnings Review — $(date +%Y-%m-%d)${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""

# Count entries by status
count_status() {
    local file="$1"
    local status="$2"
    local n=0
    if [ -f "$file" ]; then
        n=$(grep -c "\\*\\*Status\\*\\*: ${status}" "$file" 2>/dev/null) || true
    fi
    echo "${n:-0}"
}

# Count entries by priority
count_priority() {
    local file="$1"
    local priority="$2"
    local n=0
    if [ -f "$file" ]; then
        n=$(grep -c "\\*\\*Priority\\*\\*: ${priority}" "$file" 2>/dev/null) || true
    fi
    echo "${n:-0}"
}

is_valid_iso_date() {
    local value="$1"
    local normalized=""
    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
    normalized=$(date -j -f '%Y-%m-%d' "$value" '+%Y-%m-%d' 2>/dev/null || true)
    if [ -z "$normalized" ]; then
        normalized=$(date -d "$value" '+%Y-%m-%d' 2>/dev/null || true)
    fi
    [ "$normalized" = "$value" ]
}

extract_entry_id() {
    sed -n 's/^## \[\([A-Z][A-Z]*-[0-9][0-9]*-[A-Z0-9][A-Z0-9]*\)\].*/\1/p'
}

extract_field() {
    local field="$1"
    sed -n "s/^\\*\\*${field}\\*\\*: \\(.*\\)$/\\1/p" | head -1
}

# Print file summary
summarize_file() {
    local file="$1"
    local label="$2"

    if [ ! -f "$file" ]; then
        echo -e "  ${label}: ${YELLOW}not found${NC}"
        return
    fi

    local total=0 pending resolved promoted
    total=$(grep -c '^\## \[' "$file" 2>/dev/null) || true
    pending=$(count_status "$file" "pending")
    resolved=$(count_status "$file" "resolved")
    promoted=$(grep -c "\\*\\*Status\\*\\*: promoted" "$file" 2>/dev/null) || true

    local critical high
    critical=$(count_priority "$file" "critical")
    high=$(count_priority "$file" "high")

    local color="${GREEN}"
    if [ "$critical" -gt 0 ]; then
        color="${RED}"
    elif [ "$pending" -gt 0 ] && [ "$high" -gt 0 ]; then
        color="${YELLOW}"
    fi

    echo -e "  ${color}${label}${NC}: ${total} total | ${pending} pending | ${resolved} resolved | ${promoted} promoted"

    if [ "$critical" -gt 0 ]; then
        echo -e "    ${RED}⚠ ${critical} critical${NC}"
    fi
    if [ "$high" -gt 0 ]; then
        echo -e "    ${YELLOW}! ${high} high priority${NC}"
    fi
}

echo -e "${BOLD}Summary${NC}"
summarize_file "$LEARNINGS_DIR/LEARNINGS.md" "Learnings"
summarize_file "$LEARNINGS_DIR/ERRORS.md" "Errors"
summarize_file "$LEARNINGS_DIR/FEATURE_REQUESTS.md" "Features"
echo ""

# Find promotion candidates (entries with 2+ See Also links)
echo -e "${BOLD}Promotion Candidates${NC}"
promotion_found=false

for f in "$LEARNINGS_DIR"/LEARNINGS.md "$LEARNINGS_DIR"/ERRORS.md "$LEARNINGS_DIR"/FEATURE_REQUESTS.md; do
    [ -f "$f" ] || continue

    # Find entries with See Also links
    while IFS= read -r id_line; do
        entry_id=$(printf '%s\n' "$id_line" | extract_entry_id)
        [ -z "$entry_id" ] && continue

        see_also_count=$(awk "/^## \\[$entry_id\\]/{found=1} found && /See Also:/{print; found=0}" "$f" | grep -Eo '[A-Z]+-[0-9]+-[A-Z0-9]+' | wc -l | tr -d ' ' || true)
        see_also_count="${see_also_count:-0}"

        if [ "$see_also_count" -ge 2 ]; then
            summary=$(awk "/^## \\[$entry_id\\]/{found=1} found && /^### Summary/{getline; print; found=0}" "$f" | head -1 | sed 's/^[[:space:]]*//')
            echo -e "  ${CYAN}→ $entry_id${NC} ($see_also_count related) — $summary"
            promotion_found=true
        fi
    done < <(grep '^\## \[' "$f" 2>/dev/null || true)
done

if [ "$promotion_found" = false ]; then
    echo -e "  ${GREEN}No promotion candidates yet.${NC}"
fi
echo ""

echo -e "${BOLD}Candidate Review Queue${NC}"
candidate_found=false
today=$(date +%Y-%m-%d)
if [ -d "$CANDIDATES_DIR" ]; then
    for candidate in "$CANDIDATES_DIR"/*.md; do
        [ -f "$candidate" ] || continue
        candidate_found=true
        candidate_file_id=$(basename "$candidate" .md)
        candidate_header_count=$(grep -c '^# Promotion Candidate: ' "$candidate" 2>/dev/null || true)
        candidate_id=$(awk '/^# Promotion Candidate: /{sub(/^# Promotion Candidate: /, ""); print; exit}' "$candidate")
        status_count=$(grep -c '^- Status: ' "$candidate" 2>/dev/null || true)
        status=$(awk '/^- Status: /{sub(/^- Status: /, ""); print; exit}' "$candidate")
        source_count=$(grep -c '^- Source: ' "$candidate" 2>/dev/null || true)
        source=$(awk '/^- Source: /{sub(/^- Source: /, ""); print; exit}' "$candidate")
        emitted_count=$(grep -c '^- Emitted: ' "$candidate" 2>/dev/null || true)
        emitted=$(awk '/^- Emitted: /{sub(/^- Emitted: /, ""); print; exit}' "$candidate")
        reevaluate_count=$(grep -c '^- Re-evaluate by: ' "$candidate" 2>/dev/null || true)
        reevaluate=$(awk '/^- Re-evaluate by: /{sub(/^- Re-evaluate by: /, ""); print; exit}' "$candidate")
        target_count=$(grep -c '^- Proposed target: ' "$candidate" 2>/dev/null || true)
        target=$(awk '/^- Proposed target: /{sub(/^- Proposed target: /, ""); print; exit}' "$candidate")
        summary_count=$(grep -c '^- Summary: ' "$candidate" 2>/dev/null || true)
        summary=$(awk '/^- Summary: /{sub(/^- Summary: /, ""); print; exit}' "$candidate")
        qualification_count=$(grep -Fc -- '- Qualification (reviewer must confirm ONE):' "$candidate" 2>/dev/null || true)
        recurrence_option_count=$(grep -Ec '^  - \[[ xX]\] Recurrence:' "$candidate" 2>/dev/null || true)
        operator_option_count=$(grep -Ec '^  - \[[ xX]\] Operator-directed:' "$candidate" 2>/dev/null || true)
        proposed_entry_count=$(grep -c '^## Proposed entry$' "$candidate" 2>/dev/null || true)
        proposed_entry_body=$(awk '/^## Proposed entry$/{found=1; next} found && /^## /{exit} found && NF{print; exit}' "$candidate")
        landing_procedure_count=$(grep -c '^## Landing procedure$' "$candidate" 2>/dev/null || true)
        landing_procedure_body=$(awk '/^## Landing procedure$/{found=1; next} found && /^## /{exit} found && NF{print; exit}' "$candidate")
        lifecycle="active"
        color="$CYAN"
        candidate_errors=()
        [ "$candidate_header_count" -eq 1 ] || candidate_errors+=("candidate header must appear once")
        [[ "$candidate_id" =~ ^[A-Z]+-[0-9]{8}-[A-Z0-9]+$ ]] || candidate_errors+=("invalid candidate id")
        [ "$candidate_id" = "$candidate_file_id" ] || candidate_errors+=("header/file id mismatch")
        [ "$status_count" -eq 1 ] || candidate_errors+=("status must appear once")
        [ "$status" = "candidate (pending human review)" ] || candidate_errors+=("invalid status")
        [ "$source_count" -eq 1 ] || candidate_errors+=("source must appear once")
        source_path_valid=false
        case "$source" in
            "$LEARNINGS_DIR/LEARNINGS.md"|"$LEARNINGS_DIR/ERRORS.md"|"$LEARNINGS_DIR/FEATURE_REQUESTS.md") source_path_valid=true ;;
            *) candidate_errors+=("invalid source") ;;
        esac
        if [ "$source_path_valid" = true ] && [[ "$candidate_id" =~ ^[A-Z]+-[0-9]{8}-[A-Z0-9]+$ ]]; then
            source_header_total=0
            source_header_file=""
            for source_file in "$LEARNINGS_DIR/LEARNINGS.md" "$LEARNINGS_DIR/ERRORS.md" "$LEARNINGS_DIR/FEATURE_REQUESTS.md"; do
                [ -f "$source_file" ] || continue
                source_file_count=$(grep -Ec "^## \[$candidate_id\]([[:space:]]|$)" "$source_file" 2>/dev/null || true)
                if [ "$source_file_count" -gt 0 ]; then
                    source_header_total=$((source_header_total + source_file_count))
                    source_header_file="$source_file"
                fi
            done
            [ "$source_header_total" -eq 1 ] || candidate_errors+=("source id must appear exactly once")
            [ "$source_header_file" = "$source" ] || candidate_errors+=("source path does not own candidate id")
            if [ "$source_header_total" -eq 1 ] && [ "$source_header_file" = "$source" ]; then
                source_entry=$(awk "/^## \[$candidate_id\]/{found=1} found{print} found && /^---$/{exit}" "$source")
                source_status_count=$(printf '%s\n' "$source_entry" | grep -c '^\*\*Status\*\*: ' || true)
                source_status=$(printf '%s\n' "$source_entry" | extract_field "Status")
                [ "$source_status_count" -eq 1 ] || candidate_errors+=("source status must appear once")
                [ "$source_status" = "pending" ] || candidate_errors+=("source status must be pending")
                source_summary_count=$(printf '%s\n' "$source_entry" | grep -c '^### Summary$' || true)
                source_summary=$(printf '%s\n' "$source_entry" | awk '/^### Summary$/{getline; sub(/^[[:space:]]*/, ""); print; exit}')
                [ "$source_summary_count" -eq 1 ] || candidate_errors+=("source summary must appear once")
                [ -n "$source_summary" ] || candidate_errors+=("source summary must not be empty")
                [ "$source_summary" = "$summary" ] || candidate_errors+=("candidate summary must match source summary")
            fi
        fi
        [ "$summary_count" -eq 1 ] || candidate_errors+=("summary must appear once")
        [ -n "$summary" ] || candidate_errors+=("missing summary")
        [ "$target_count" -eq 1 ] || candidate_errors+=("target must appear once")
        [ "$target" = "AGENTS.md" ] || candidate_errors+=("invalid target")
        [ "$emitted_count" -eq 1 ] || candidate_errors+=("emitted date must appear once")
        is_valid_iso_date "$emitted" || candidate_errors+=("invalid emitted date")
        [ "$reevaluate_count" -eq 1 ] || candidate_errors+=("re-evaluation date must appear once")
        is_valid_iso_date "$reevaluate" || candidate_errors+=("invalid re-evaluation date")
        if is_valid_iso_date "$emitted" && is_valid_iso_date "$reevaluate" && [[ "$reevaluate" < "$emitted" || "$reevaluate" == "$emitted" ]]; then
            candidate_errors+=("re-evaluation date must follow emitted date")
        fi
        [ "$qualification_count" -eq 1 ] || candidate_errors+=("qualification block must appear once")
        [ "$recurrence_option_count" -eq 1 ] || candidate_errors+=("recurrence option must appear once")
        [ "$operator_option_count" -eq 1 ] || candidate_errors+=("operator-directed option must appear once")
        [ "$proposed_entry_count" -eq 1 ] || candidate_errors+=("proposed entry must appear once")
        [ -n "$proposed_entry_body" ] || candidate_errors+=("proposed entry must not be empty")
        [ "$landing_procedure_count" -eq 1 ] || candidate_errors+=("landing procedure must appear once")
        [ -n "$landing_procedure_body" ] || candidate_errors+=("landing procedure must not be empty")
        if [ "${#candidate_errors[@]}" -gt 0 ]; then
            candidate_error_text=$(IFS=', '; echo "${candidate_errors[*]}")
            lifecycle="invalid ($candidate_error_text)"
            color="$RED"
        elif [[ "$reevaluate" < "$today" ]]; then
            lifecycle="expired"
            color="$RED"
        fi
        echo -e "  ${color}→ ${candidate_id:-$(basename "$candidate" .md)}${NC} [$lifecycle] target=${target:-unknown} re-evaluate=${reevaluate:-missing}"
        echo "    $summary"
    done
fi
if [ "$candidate_found" = false ]; then
    echo -e "  ${GREEN}No emitted candidates awaiting review.${NC}"
fi
echo ""

# Pending high/critical items
echo -e "${BOLD}Action Required (pending high/critical)${NC}"
action_found=false

for f in "$LEARNINGS_DIR"/LEARNINGS.md "$LEARNINGS_DIR"/ERRORS.md "$LEARNINGS_DIR"/FEATURE_REQUESTS.md; do
    [ -f "$f" ] || continue

    while IFS= read -r id_line; do
        entry_id=$(printf '%s\n' "$id_line" | extract_entry_id)
        [ -z "$entry_id" ] && continue

        # Check if pending AND high/critical
        entry_block=$(awk "/^## \\[$entry_id\\]/{found=1} found{print} found && /^---$/{exit}" "$f")
        is_pending=$(printf '%s\n' "$entry_block" | grep -c "\\*\\*Status\\*\\*: pending" || true)
        is_high=$(printf '%s\n' "$entry_block" | grep -cE "\\*\\*Priority\\*\\*: (high|critical)" || true)
        is_pending="${is_pending:-0}"
        is_high="${is_high:-0}"

        if [ "$is_pending" -gt 0 ] && [ "$is_high" -gt 0 ]; then
            priority=$(printf '%s\n' "$entry_block" | extract_field "Priority")
            priority="${priority:-?}"
            summary=$(echo "$entry_block" | awk '/^### Summary/{getline; print}' | head -1 | sed 's/^[[:space:]]*//')
            echo -e "  ${RED}[$priority] $entry_id${NC} — $summary"
            action_found=true
        fi
    done < <(grep '^\## \[' "$f" 2>/dev/null || true)
done

if [ "$action_found" = false ]; then
    echo -e "  ${GREEN}No urgent items.${NC}"
fi
echo ""

# Full listing (optional)
if [ "$FULL" = true ]; then
    echo -e "${BOLD}All Pending Entries${NC}"
    for f in "$LEARNINGS_DIR"/LEARNINGS.md "$LEARNINGS_DIR"/ERRORS.md "$LEARNINGS_DIR"/FEATURE_REQUESTS.md; do
        [ -f "$f" ] || continue
        fname=$(basename "$f" .md)
        while IFS= read -r id_line; do
            entry_id=$(printf '%s\n' "$id_line" | extract_entry_id)
            [ -z "$entry_id" ] && continue

            entry_block=$(awk "/^## \\[$entry_id\\]/{found=1} found{print} found && /^---$/{exit}" "$f")
            is_pending=$(printf '%s\n' "$entry_block" | grep -c "\\*\\*Status\\*\\*: pending" || true)
            is_pending="${is_pending:-0}"

            if [ "$is_pending" -gt 0 ]; then
                priority=$(printf '%s\n' "$entry_block" | extract_field "Priority")
                priority="${priority:-?}"
                area=$(printf '%s\n' "$entry_block" | extract_field "Area")
                area="${area:-?}"
                summary=$(echo "$entry_block" | awk '/^### Summary/{getline; print}' | head -1 | sed 's/^[[:space:]]*//')
                echo -e "  [$priority/$area] $entry_id — $summary"
            fi
        done < <(grep '^\## \[' "$f" 2>/dev/null || true)
    done
    echo ""
fi

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
