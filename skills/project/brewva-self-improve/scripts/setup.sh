#!/usr/bin/env bash
# Initialize .brewva/learnings/ in the current workspace.
# Copies template files from assets/ if the directory doesn't exist.
# Safe to run multiple times — skips existing files.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Resolve the skill's own directory (where assets/ lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$SKILL_DIR/assets"

# Target: .brewva/learnings/ in the workspace root
# Walk up from cwd looking for .brewva/ or .git/ as workspace marker
find_workspace_root() {
    local dir="$PWD"
    while [ "$dir" != "/" ]; do
        if [ -d "$dir/.brewva" ] || [ -d "$dir/.git" ]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    echo "$PWD"
}

WORKSPACE=$(find_workspace_root)
TARGET_DIR="$WORKSPACE/.brewva/learnings"

if [ ! -d "$ASSETS_DIR" ]; then
    echo -e "${YELLOW}[WARN]${NC} Assets directory not found: $ASSETS_DIR"
    echo "Creating empty learnings directory..."
    mkdir -p "$TARGET_DIR"
    exit 0
fi

mkdir -p "$TARGET_DIR"

copied=0
for template in "$ASSETS_DIR"/*.md; do
    [ -f "$template" ] || continue
    filename="$(basename "$template")"
    if [ ! -f "$TARGET_DIR/$filename" ]; then
        cp "$template" "$TARGET_DIR/$filename"
        echo -e "${GREEN}[OK]${NC} Created $TARGET_DIR/$filename"
        copied=$((copied + 1))
    else
        echo -e "${YELLOW}[SKIP]${NC} $TARGET_DIR/$filename already exists"
    fi
done

echo ""
if [ "$copied" -gt 0 ]; then
    echo -e "${GREEN}Initialized $copied learnings files in $TARGET_DIR${NC}"
else
    echo "All learnings files already present."
fi
