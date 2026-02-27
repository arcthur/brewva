#!/usr/bin/env bash
# Brewva Learning Review / Audit
# Summarizes pending items across all learning files and identifies promotion candidates.
# Usage: ./review.sh [--full]

set -euo pipefail

LEARNINGS_DIR="./.brewva/learnings"

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
        entry_id=$(echo "$id_line" | grep -oP '\[\K[A-Z]+-\d+-[A-Z0-9]+' || true)
        [ -z "$entry_id" ] && continue

        see_also_count=$(awk "/^## \\[$entry_id\\]/{found=1} found && /See Also:/{print; found=0}" "$f" | grep -oP '[A-Z]+-\d+-[A-Z0-9]+' | wc -l 2>/dev/null || echo 0)

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

# Pending high/critical items
echo -e "${BOLD}Action Required (pending high/critical)${NC}"
action_found=false

for f in "$LEARNINGS_DIR"/LEARNINGS.md "$LEARNINGS_DIR"/ERRORS.md "$LEARNINGS_DIR"/FEATURE_REQUESTS.md; do
    [ -f "$f" ] || continue

    while IFS= read -r id_line; do
        entry_id=$(echo "$id_line" | grep -oP '\[\K[A-Z]+-\d+-[A-Z0-9]+' || true)
        [ -z "$entry_id" ] && continue

        # Check if pending AND high/critical
        entry_block=$(awk "/^## \\[$entry_id\\]/{found=1} found{print} found && /^---$/{exit}" "$f")
        is_pending=$(echo "$entry_block" | grep -c "\\*\\*Status\\*\\*: pending" || echo 0)
        is_high=$(echo "$entry_block" | grep -cE "\\*\\*Priority\\*\\*: (high|critical)" || echo 0)

        if [ "$is_pending" -gt 0 ] && [ "$is_high" -gt 0 ]; then
            priority=$(echo "$entry_block" | grep -oP '\\*\\*Priority\\*\\*: \K\w+' || echo "?")
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
            entry_id=$(echo "$id_line" | grep -oP '\[\K[A-Z]+-\d+-[A-Z0-9]+' || true)
            [ -z "$entry_id" ] && continue

            entry_block=$(awk "/^## \\[$entry_id\\]/{found=1} found{print} found && /^---$/{exit}" "$f")
            is_pending=$(echo "$entry_block" | grep -c "\\*\\*Status\\*\\*: pending" || echo 0)

            if [ "$is_pending" -gt 0 ]; then
                priority=$(echo "$entry_block" | grep -oP '\\*\\*Priority\\*\\*: \K\w+' || echo "?")
                area=$(echo "$entry_block" | grep -oP '\\*\\*Area\\*\\*: \K\w+' || echo "?")
                summary=$(echo "$entry_block" | awk '/^### Summary/{getline; print}' | head -1 | sed 's/^[[:space:]]*//')
                echo -e "  [$priority/$area] $entry_id — $summary"
            fi
        done < <(grep '^\## \[' "$f" 2>/dev/null || true)
    done
    echo ""
fi

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
