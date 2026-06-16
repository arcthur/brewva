// Tools that remain usable when the forced-compaction gate is armed.
// Keep this list minimal: anything allowed here can bypass "compact-first" recovery.
export const CONTEXT_CRITICAL_ALLOWED_TOOLS = ["workbench_compact"];
