import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  getHostedTurnTransitionCoordinator,
  type HostedTransitionSnapshot,
} from "../session/turn-transition.js";
import type { HostedDelegationStore } from "../subagents/delegation-store.js";
import type { ComposedContextBlock } from "./context-composer.js";
import { estimateTokens } from "./tool-output-distiller.js";

const RECOVERY_WORKING_SET_REASONS = new Set([
  "compaction_retry",
  "provider_fallback_retry",
  "max_output_recovery",
  "reasoning_revert_resume",
  "output_budget_escalation",
  "wal_recovery_resume",
]);

function normalizeText(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function shouldIncludeRecoveryWorkingSet(snapshot: HostedTransitionSnapshot): boolean {
  if (snapshot.pendingFamily === "recovery" || snapshot.pendingFamily === "output_budget") {
    return true;
  }
  const latestReason = snapshot.latest?.reason;
  return typeof latestReason === "string" && RECOVERY_WORKING_SET_REASONS.has(latestReason);
}

function buildRecoveryWorkingSetContent(input: {
  snapshot: HostedTransitionSnapshot;
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  delegationStore?: HostedDelegationStore;
}): string | null {
  if (!shouldIncludeRecoveryWorkingSet(input.snapshot)) {
    return null;
  }

  const taskState = input.runtime.inspect.task.getState(input.sessionId);
  const pendingDelegationOutcomes =
    input.delegationStore?.listPendingOutcomes(input.sessionId, {
      limit: 6,
    }) ?? [];

  const lines = ["[RecoveryWorkingSet]"];
  const latest = input.snapshot.latest;
  if (latest) {
    lines.push(`latest_reason: ${latest.reason}`);
    lines.push(`latest_status: ${latest.status}`);
  }
  if (input.snapshot.pendingFamily) {
    lines.push(`pending_family: ${input.snapshot.pendingFamily}`);
  }
  const goal = normalizeText(taskState.spec?.goal);
  if (goal) {
    lines.push(`task_goal: ${goal}`);
  }
  const phase = normalizeText(taskState.status?.phase);
  if (phase) {
    lines.push(`task_phase: ${phase}`);
  }
  const health = normalizeText(taskState.status?.health);
  if (health) {
    lines.push(`task_health: ${health}`);
  }
  const acceptanceStatus = normalizeText(taskState.acceptance?.status);
  if (acceptanceStatus) {
    lines.push(`acceptance_status: ${acceptanceStatus}`);
  }
  if (taskState.blockers.length > 0) {
    lines.push(`open_blockers: ${taskState.blockers.length}`);
  }
  if (pendingDelegationOutcomes.length > 0) {
    lines.push(`pending_delegation_outcomes: ${pendingDelegationOutcomes.length}`);
  }
  lines.push(
    "resume_contract: continue from the current working projection and task state; do not replay completed tool side effects unless correctness requires it.",
  );

  return lines.join("\n");
}

export function resolveRecoveryWorkingSetBlock(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    delegationStore?: HostedDelegationStore;
  },
): ComposedContextBlock | null {
  const snapshot = getHostedTurnTransitionCoordinator(runtime).getSnapshot(input.sessionId);
  const content = buildRecoveryWorkingSetContent({
    snapshot,
    runtime,
    sessionId: input.sessionId,
    delegationStore: input.delegationStore,
  });
  if (!content) {
    return null;
  }
  return {
    id: "recovery-working-set",
    category: "constraint",
    content,
    estimatedTokens: estimateTokens(content),
  };
}

export const RECOVERY_WORKING_SET_TEST_ONLY = {
  buildRecoveryWorkingSetContent,
  shouldIncludeRecoveryWorkingSet,
};
