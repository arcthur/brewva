#!/usr/bin/env bash
# Brewva Learning Promotion Helper
# Promotes a learning entry to a permanent project knowledge target.
# Usage: ./promote.sh <entry-id> <target> [--dry-run]

set -euo pipefail

LEARNINGS_DIR="./.brewva/learnings"
AGENTS_FILE="./AGENTS.md"

# Abort early if learnings dir doesn't exist
if [ ! -d "$LEARNINGS_DIR" ]; then
    echo -e "\033[0;31m[ERROR]\033[0m No learnings directory found at $LEARNINGS_DIR" >&2
    echo "Run: ./skills/project/brewva-self-improve/scripts/setup.sh" >&2
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

Promote a learning entry to a permanent knowledge location.

Arguments:
  entry-id    Learning entry ID (e.g. LRN-20260226-001)
  target      Promotion target:
                agents     → append to AGENTS.md
                docs       → print for manual addition to docs/
                skill      → redirect to extract-skill.sh

Options:
  --dry-run   Show what would be promoted without modifying files
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

result=$(find_entry "$ENTRY_ID")
SOURCE_FILE=$(echo "$result" | head -1)
ENTRY_CONTENT=$(echo "$result" | sed '1d;2d')

log_info "Found $ENTRY_ID in $SOURCE_FILE"

# Extract summary line
SUMMARY=$(echo "$ENTRY_CONTENT" | grep -A1 "^### Summary" | tail -1 | sed 's/^[[:space:]]*//')

case "$TARGET" in
    agents)
        AGENTS_ENTRY=$(cat << ENTRY

### $ENTRY_ID: $SUMMARY

$(echo "$ENTRY_CONTENT" | awk '/^### Details/,/^### /' | head -n -1 | tail -n +2 | sed 's/^[[:space:]]*//')

_Promoted from \`.brewva/learnings/\` on $(date +%Y-%m-%d)._
ENTRY
)
        if [ "$DRY_RUN" = true ]; then
            log_info "Dry run — would append to $AGENTS_FILE:"
            echo -e "${CYAN}${AGENTS_ENTRY}${NC}"
            echo ""
            log_info "Would update $SOURCE_FILE: Status → promoted, Promoted → AGENTS.md"
        else
            echo "$AGENTS_ENTRY" >> "$AGENTS_FILE"
            log_info "Appended to $AGENTS_FILE"

            # Update status in source file
            if command -v sed &>/dev/null; then
                sed -i.bak "s/^\\(## \\[$ENTRY_ID\\].*\\)/\\1/" "$SOURCE_FILE"
                # Update Status field within the entry
                awk -v id="$ENTRY_ID" '
                    /^\['"$ENTRY_ID"'\]/{found=1}
                    found && /^\*\*Status\*\*:/{
                        sub(/pending/, "promoted")
                        found=0
                    }
                    {print}
                ' "$SOURCE_FILE" > "${SOURCE_FILE}.tmp" && mv "${SOURCE_FILE}.tmp" "$SOURCE_FILE"
                rm -f "${SOURCE_FILE}.bak"
            fi

            log_info "Updated $ENTRY_ID status to promoted in $SOURCE_FILE"
            echo ""
            log_info "Promotion complete!"
            echo "  Entry: $ENTRY_ID"
            echo "  Target: $AGENTS_FILE"
            echo "  Summary: $SUMMARY"
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
        echo "  ./skills/project/brewva-self-improve/scripts/extract-skill.sh <skill-name>"
        echo ""
        echo "Then update $ENTRY_ID:"
        echo "  **Status**: promoted_to_skill"
        echo "  **Skill-Path**: skills/<tier>/<skill-name>"
        ;;
    *)
        log_error "Unknown target: $TARGET (use: agents|docs|skill)"
        exit 1
        ;;
esac
