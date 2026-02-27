#!/usr/bin/env bash
# Brewva Self-Improvement Error Detector Hook
# Hook: PostToolUse (matcher: Bash)
# Detects command failures and suggests logging with session correlation.

set -e

OUTPUT="${CLAUDE_TOOL_OUTPUT:-}"

ERROR_PATTERNS=(
    "error:"
    "Error:"
    "ERROR:"
    "error TS"
    "failed"
    "FAILED"
    "command not found"
    "No such file"
    "Permission denied"
    "fatal:"
    "Exception"
    "Traceback"
    "SyntaxError"
    "TypeError"
    "ReferenceError"
    "ModuleNotFoundError"
    "Cannot find module"
    "exit code"
    "non-zero"
    "ENOENT"
    "EACCES"
    "bun test.*fail"
    "typecheck.*error"
)

contains_error=false
for pattern in "${ERROR_PATTERNS[@]}"; do
    if [[ "$OUTPUT" == *"$pattern"* ]]; then
        contains_error=true
        break
    fi
done

if [ "$contains_error" = true ]; then
    cat << 'EOF'
<error-detected>
A command error was detected. Consider logging to .brewva/learnings/ERRORS.md if:
- The error was unexpected or non-obvious
- It required investigation to resolve
- It might recur in similar contexts

Use format: [ERR-YYYYMMDD-XXX] with Brewva area tag (runtime|tools|extensions|cli|gateway|infra|tests|docs|config).
If a session is active, include the sessionId from .orchestrator/ for traceability.
</error-detected>
EOF
fi
