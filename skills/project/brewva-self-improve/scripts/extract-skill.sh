#!/usr/bin/env bash
# Brewva Skill Extraction Helper
# Generates a Brewva DoD-compliant SKILL.md scaffold from a learning entry.
# Usage: ./extract-skill.sh <skill-name> [options]

set -euo pipefail

SKILLS_DIR="./skills/base"
TIER="base"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    cat << EOF
Usage: $(basename "$0") <skill-name> [options]

Create a Brewva DoD-compliant skill scaffold from a learning entry.

Arguments:
  skill-name     Name of the skill (lowercase, hyphens)

Options:
  --tier         Skill tier: base|pack|project (default: base)
  --output-dir   Output directory (default: ./skills/base)
  --dry-run      Show what would be created without creating files
  -h, --help     Show this help message

Examples:
  $(basename "$0") bun-test-isolation
  $(basename "$0") telegram-retry --tier pack --output-dir ./skills/packs
  $(basename "$0") gateway-health --tier project --output-dir ./skills/project
  $(basename "$0") docker-m1-fixes --dry-run
EOF
}

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

SKILL_NAME=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --tier)
            if [ -z "${2:-}" ] || [[ "${2:-}" == -* ]]; then
                log_error "--tier requires: base|pack|project"
                exit 1
            fi
            TIER="$2"
            case "$TIER" in
                base) SKILLS_DIR="./skills/base" ;;
                pack) SKILLS_DIR="./skills/packs" ;;
                project) SKILLS_DIR="./skills/project" ;;
                *) log_error "Invalid tier: $TIER (use base|pack|project)"; exit 1 ;;
            esac
            shift 2
            ;;
        --output-dir)
            if [ -z "${2:-}" ] || [[ "${2:-}" == -* ]]; then
                log_error "--output-dir requires a relative path"
                exit 1
            fi
            SKILLS_DIR="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            if [ -z "$SKILL_NAME" ]; then
                SKILL_NAME="$1"
            else
                log_error "Unexpected argument: $1"
                usage
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$SKILL_NAME" ]; then
    log_error "Skill name is required"
    usage
    exit 1
fi

if ! [[ "$SKILL_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    log_error "Invalid name format. Use lowercase letters, numbers, and hyphens."
    exit 1
fi

if [[ "$SKILLS_DIR" = /* ]]; then
    log_error "Output directory must be a relative path."
    exit 1
fi

if [[ "$SKILLS_DIR" =~ (^|/)\.\.(/|$) ]]; then
    log_error "Output directory cannot include '..' path segments."
    exit 1
fi

SKILLS_DIR="${SKILLS_DIR#./}"
SKILLS_DIR="./$SKILLS_DIR"
SKILL_PATH="$SKILLS_DIR/$SKILL_NAME"

# Title case conversion
TITLE=$(echo "$SKILL_NAME" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2))}1')

TEMPLATE=$(cat << ENDTEMPLATE
---
name: ${SKILL_NAME}
description: "[TODO: Concise description of what this skill does and when to use it]"
version: 1.0.0
stability: experimental
tier: ${TIER}
tags: [TODO]
anti_tags: []
tools:
  required: [read]
  optional: [grep, exec]
  denied: []
budget:
  max_tool_calls: 40
  max_tokens: 80000
outputs: [TODO]
consumes: []
escalation_path:
  default: exploration
---

# ${TITLE}

## Objective

[TODO: What this skill achieves and why it exists]

## Trigger

Use this skill when:

- [TODO: Condition 1]
- [TODO: Condition 2]

## Workflow

### Step 1: [TODO]

[TODO: First step description]

### Step 2: [TODO]

[TODO: Second step description]

## Stop Conditions

- [TODO: When to stop]

## Anti-Patterns (forbidden)

- [TODO: What not to do]

## Examples

### Example A — [TODO: Title]

Input:

\`\`\`text
"[TODO: Example input]"
\`\`\`

Expected flow:

1. [TODO: Step 1]
2. [TODO: Step 2]

## Source Learning

- Learning ID: [TODO: Original learning ID, e.g. LRN-20260226-001]
- Original File: .brewva/learnings/LEARNINGS.md
- Extraction Date: $(date +%Y-%m-%d)
ENDTEMPLATE
)

if [ "$DRY_RUN" = true ]; then
    log_info "Dry run — would create:"
    echo "  ${SKILL_PATH}/"
    echo "  ${SKILL_PATH}/SKILL.md"
    echo ""
    echo "Template content:"
    echo "---"
    echo "$TEMPLATE"
    echo "---"
    echo ""
    log_info "Validate with: ./skills/project/brewva-project/scripts/check-skill-dod.sh ${SKILL_PATH}"
    exit 0
fi

if [ -d "$SKILL_PATH" ]; then
    log_error "Skill already exists: $SKILL_PATH"
    exit 1
fi

log_info "Creating skill: $SKILL_NAME (tier: $TIER)"
mkdir -p "$SKILL_PATH"
echo "$TEMPLATE" > "$SKILL_PATH/SKILL.md"
log_info "Created: $SKILL_PATH/SKILL.md"

echo ""
log_info "Skill scaffold created!"
echo ""
echo "Next steps:"
echo "  1. Edit $SKILL_PATH/SKILL.md — fill in all [TODO] sections"
echo "  2. Add references/ folder if you have detailed docs"
echo "  3. Add scripts/ folder if you have executable helpers"
echo "  4. Validate: ./skills/project/brewva-project/scripts/check-skill-dod.sh $SKILL_PATH"
echo "  5. Update the source learning entry:"
echo "     **Status**: promoted_to_skill"
echo "     **Skill-Path**: ${SKILL_PATH#./}"
