#!/usr/bin/env bash
# Brewva Learning Promotion Helper
# Emits a reviewable promotion candidate for a learning entry, or routes the
# entry to its manual promotion path. No target is ever written directly:
# AGENTS.md and docs/ land only as human-reviewed diffs.
# Usage: ./promote.sh <entry-id> <target> [--dry-run]

set -euo pipefail

LEARNINGS_DIR="./.brewva/learnings"
CANDIDATES_DIR="$LEARNINGS_DIR/candidates"

# Abort early if learnings dir doesn't exist
if [ ! -d "$LEARNINGS_DIR" ]; then
    echo -e "\033[0;31m[ERROR]\033[0m No learnings directory found at $LEARNINGS_DIR" >&2
    echo "Run: ./skills/meta/self-improve/scripts/setup.sh" >&2
    exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
    cat << EOF
Usage: $(basename "$0") <entry-id> <target> [options]

Emit a promotion candidate for a learning entry. Candidates are files for
human review; landing in the target is always a reviewed diff, never an
automated write.

Arguments:
  entry-id    Learning entry ID (e.g. LRN-20260226-001)
  target      Promotion target:
                agents     → emit a candidate file targeting AGENTS.md
                docs       → print for manual addition to docs/
                skill      → redirect to extract-skill.sh

Options:
  --dry-run   Show the candidate that would be emitted without writing files
  -h, --help  Show this help message

Examples:
  $(basename "$0") LRN-20260226-001 agents
  $(basename "$0") ERR-20260226-003 agents --dry-run
  $(basename "$0") LRN-20260226-005 skill
EOF
}

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

ENTRY_ID=""
TARGET=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) usage; exit 0 ;;
        -*)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            if [ -z "$ENTRY_ID" ]; then
                ENTRY_ID="$1"
            elif [ -z "$TARGET" ]; then
                TARGET="$1"
            else
                log_error "Unexpected argument: $1"
                usage
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$ENTRY_ID" ] || [ -z "$TARGET" ]; then
    log_error "Both entry-id and target are required"
    usage
    exit 1
fi

# Find the entry across all learning files
find_entry() {
    local id="$1"
    local file=""
    local content=""

    for f in "$LEARNINGS_DIR"/LEARNINGS.md "$LEARNINGS_DIR"/ERRORS.md "$LEARNINGS_DIR"/FEATURE_REQUESTS.md; do
        if [ -f "$f" ] && grep -q "\[$id\]" "$f"; then
            file="$f"
            break
        fi
    done

    if [ -z "$file" ]; then
        log_error "Entry $id not found in $LEARNINGS_DIR/"
        exit 1
    fi

    # Extract the entry block (from ## [ID] to next --- or EOF)
    content=$(awk "/^## \\[$id\\]/{found=1} found{print} found && /^---$/ && NR>1{exit}" "$file")

    if [ -z "$content" ]; then
        log_error "Could not extract content for $id from $file"
        exit 1
    fi

    echo "$file"
    echo "---CONTENT---"
    echo "$content"
}

# Update the entry's Status field in its source file.
set_entry_status() {
    local id="$1"
    local file="$2"
    local new_status="$3"
    awk -v id="$id" -v status="$new_status" '
        $0 ~ "^## \\[" id "\\]" { found = 1 }
        found && /^\*\*Status\*\*:/ {
            sub(/:.*$/, ": " status)
            found = 0
        }
        { print }
    ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

result=$(find_entry "$ENTRY_ID")
SOURCE_FILE=$(echo "$result" | head -1)
ENTRY_CONTENT=$(echo "$result" | sed '1d;2d')

log_info "Found $ENTRY_ID in $SOURCE_FILE"

# Extract summary line
SUMMARY=$(echo "$ENTRY_CONTENT" | grep -A1 "^### Summary" | tail -1 | sed 's/^[[:space:]]*//')

EMITTED_DATE=$(date +%Y-%m-%d)
# BSD date (macOS) first, GNU date fallback.
REEVALUATE_DATE=$(date -v+90d +%Y-%m-%d 2>/dev/null || date -d "+90 days" +%Y-%m-%d)

case "$TARGET" in
    agents)
        CANDIDATE_FILE="$CANDIDATES_DIR/$ENTRY_ID.md"
        CANDIDATE_CONTENT=$(cat << CANDIDATE
# Promotion Candidate: $ENTRY_ID

- Status: candidate (pending human review)
- Summary: $SUMMARY
- Source: $SOURCE_FILE
- Proposed target: AGENTS.md
- Emitted: $EMITTED_DATE
- Re-evaluate by: $REEVALUATE_DATE
- Qualification (reviewer must confirm ONE):
  - [ ] Recurrence: 2+ independent occurrences cited below
  - [ ] Operator-directed: an explicit human instruction to promote (an
        authorization signal — correctness still rides on this review)

## Proposed entry

$ENTRY_CONTENT

## Landing procedure

A human reviews this candidate. If accepted, land the entry in AGENTS.md as a
normal reviewed diff (commit + review), then set the source entry's Status to
promoted and record the landing commit here. If rejected or expired
(re-evaluate date passed without landing), set the source entry's Status back
to pending and delete this file. There is no automated append path to
AGENTS.md.
CANDIDATE
)
        if [ "$DRY_RUN" = true ]; then
            log_info "Dry run — would write candidate to $CANDIDATE_FILE:"
            echo -e "${CYAN}${CANDIDATE_CONTENT}${NC}"
            echo ""
            log_info "Would update $SOURCE_FILE: Status → candidate"
        else
            mkdir -p "$CANDIDATES_DIR"
            printf '%s\n' "$CANDIDATE_CONTENT" > "$CANDIDATE_FILE"
            log_info "Candidate written to $CANDIDATE_FILE"

            set_entry_status "$ENTRY_ID" "$SOURCE_FILE" "candidate"
            log_info "Updated $ENTRY_ID status to candidate in $SOURCE_FILE"
            echo ""
            log_info "Candidate emitted — NOT landed."
            echo "  Entry: $ENTRY_ID"
            echo "  Candidate: $CANDIDATE_FILE"
            echo "  Summary: $SUMMARY"
            echo "  Next: human review, then land in AGENTS.md as a reviewed diff."
        fi
        ;;
    docs)
        log_info "Docs promotion — manual step required."
        echo ""
        echo "Add the following to the appropriate docs/reference/ file:"
        echo ""
        echo -e "${CYAN}${ENTRY_CONTENT}${NC}"
        echo ""
        echo "After adding, update $SOURCE_FILE:"
        echo "  **Status**: promoted"
        echo "  **Promoted**: docs/reference/<file>"
        ;;
    skill)
        log_info "Redirecting to skill extraction..."
        echo ""
        echo "Run:"
        echo "  ./skills/meta/self-improve/scripts/extract-skill.sh <skill-name> --category <core|domain|operator|meta|overlay>"
        echo ""
        echo "Then update $ENTRY_ID:"
        echo "  **Status**: promoted_to_skill"
        echo "  **Skill-Path**: skills/<category>/<skill-name> or skills/project/overlays/<skill-name>"
        ;;
    *)
        log_error "Unknown target: $TARGET (use: agents|docs|skill)"
        exit 1
        ;;
esac
