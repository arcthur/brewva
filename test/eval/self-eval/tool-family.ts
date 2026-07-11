/**
 * Tool -> family grouping for the self-eval evaluator's per-family invocation
 * view. It mirrors the tool-surface RFC's family taxonomy and the offline
 * `analyze:advisory-receipts` per-family table. The two copies are byte-identical
 * today but INDEPENDENTLY MAINTAINED (the freeze note below) and unguarded, so
 * comparability with that recipe holds only while a taxonomy change is applied
 * to both — keep them in sync by hand.
 *
 * It is deliberately OWNED by the frozen evaluator rather than imported from the
 * mutable `analyze-advisory-receipts` script: scoring definitions sit on the D6
 * freeze surface, so the grouping that DEFINES a metric must not be able to move
 * as a side effect of editing an unfrozen analysis script. The two definitions
 * change only as reviewed code; converging them onto one shared home is a
 * possible later cleanup, not a freeze-safe automatic coupling.
 *
 * Host-plane primitives (`read`/`glob`/`edit`/`exec`/`grep`) report under their
 * own name — the tool-surface finding is precisely that a strong model routes
 * to these few, so they are the signal, not noise to be bucketed away.
 */
export function toolFamily(toolName: string): string {
  if (toolName.startsWith("code_")) return "code";
  if (toolName.startsWith("attention_")) return "attention";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("lsp_")) return "lsp";
  if (toolName.startsWith("source_patch_")) return "source_patch";
  if (toolName.startsWith("recall_")) return "recall";
  if (toolName.startsWith("knowledge_")) return "knowledge";
  if (toolName.startsWith("precedent_")) return "precedent";
  if (toolName.startsWith("workbench_")) return "workbench";
  if (toolName.startsWith("worker_results_")) return "worker_results";
  if (toolName.startsWith("subagent_")) return "subagent";
  if (toolName.startsWith("task_")) return "task_ledger";
  if (toolName.startsWith("tape_")) return "tape";
  if (toolName.startsWith("git_")) return "git";
  if (toolName.startsWith("obs_")) return "obs";
  if (toolName.startsWith("agent_")) return "agent";
  if (toolName.startsWith("reasoning_")) return "reasoning";
  if (toolName.startsWith("iteration_")) return "iteration";
  if (toolName.endsWith("_plan_map") || toolName.endsWith("_plan_ticket")) return "plan_map";
  if (toolName === "record_fog" || toolName === "graduate_fog") return "plan_map";
  if (toolName === "get_goal" || toolName === "update_goal") return "goal";
  return toolName;
}
