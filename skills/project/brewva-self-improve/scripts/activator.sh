#!/usr/bin/env bash
# Brewva Self-Improvement Activator Hook
# Hook: UserPromptSubmit
# Injects a lightweight reminder (~60 tokens) to evaluate learning signals.
# Auto-creates .brewva/learnings/ in workspace if missing.

set -e

# Ensure learnings dir exists in workspace
if [ ! -d ".brewva/learnings" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    ASSETS_DIR="$SCRIPT_DIR/../assets"
    mkdir -p ".brewva/learnings"
    for f in "$ASSETS_DIR"/*.md; do
        [ -f "$f" ] && cp -n "$f" ".brewva/learnings/" 2>/dev/null || true
    done
fi

cat << 'EOF'
<self-improvement-reminder>
After completing this task, evaluate if extractable knowledge emerged:
- Non-obvious solution discovered through investigation?
- Workaround for unexpected Brewva behavior?
- Project convention learned (runtime/tools/extensions/cli/gateway)?
- Error required debugging to resolve?
- Better approach found for a recurring pattern?

If yes: Log to .brewva/learnings/ using the brewva-self-improve skill format.
If recurring (2+ See Also links): Consider skill extraction via extract-skill.sh.
If broadly applicable: Consider promotion to AGENTS.md via promote.sh.
</self-improvement-reminder>
EOF
