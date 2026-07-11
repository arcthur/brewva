import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { OperationalClaim } from "@brewva/brewva-vocabulary/iteration";
import type {
  ScheduleContinuityMode,
  ScheduleIntentProjectionRecord,
} from "@brewva/brewva-vocabulary/schedule";
import {
  decideContinuationAnchorRelevance,
  type ManagedToolMode,
} from "@brewva/brewva-vocabulary/session";
import type { TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import {
  getRuntimeClaimState,
  getRuntimeTapeStatus,
  getRuntimeTaskState,
  recordRuntimeScheduleChildFailed,
  recordRuntimeScheduleChildFinished,
  recordRuntimeScheduleChildStarted,
  recordRuntimeScheduleWakeup,
} from "../hosted/api.js";
import type {
  ScheduleApprovalMode,
  ScheduleIntentIdentity,
  SchedulePromptAnchor,
  SchedulePromptTrigger,
  SessionBackend,
} from "./session-backend.js";

export interface ScheduleContinuationSnapshot {
  taskSpec: TaskSpec | null;
  claims: OperationalClaim[];
  parentAnchor: SchedulePromptAnchor | null;
}

function clampText(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function hasScheduleContinuationAnchorMetadata(
  anchor: SchedulePromptAnchor | null | undefined,
): anchor is SchedulePromptAnchor {
  return Boolean(anchor && decideContinuationAnchorRelevance(anchor).include);
}

/**
 * The approval envelope for a scheduled run is authorized from PROVENANCE, never
 * from a model-reachable name-tuple. Three conditions must all hold: the config
 * explicitly opts the lane into `auto_within_envelope`; the fired intent carries
 * the unforgeable `origin: "config_policy"` stamp that only the daemon reconcile
 * writes; and its identity matches the config-authored intent. The origin stamp
 * is load-bearing: the scheduler folds every session's `schedule.intent` events
 * into one global map keyed by intentId, so a model that mints a colliding
 * intentId could otherwise perturb the record the resolver reads. Model-minted
 * intents never carry the stamp (and the `schedule_intent` tool refuses the
 * reserved config identity outright), so they always resolve to "suspend"
 * (fail-closed, axiom 4: govern effects).
 */
export function resolveScheduleApprovalMode(input: {
  intent: Pick<ScheduleIntentProjectionRecord, "intentId" | "parentSessionId" | "origin">;
  selfImprovePolicy: {
    readonly enabled: boolean;
    readonly approvalMode: ScheduleApprovalMode;
    readonly intentId: string;
    readonly parentSessionId: string;
  };
}): ScheduleApprovalMode {
  const policy = input.selfImprovePolicy;
  if (!policy.enabled) return "suspend";
  if (policy.approvalMode !== "auto_within_envelope") return "suspend";
  if (input.intent.origin !== "config_policy") return "suspend";
  if (input.intent.intentId !== policy.intentId) return "suspend";
  if (input.intent.parentSessionId !== policy.parentSessionId) return "suspend";
  return "auto_within_envelope";
}

export function buildScheduleWorkerSessionId(input: {
  intentId: string;
  runIndex: number;
}): string {
  return `schedule:${input.intentId}:${input.runIndex}`;
}

export function collectScheduleContinuationSnapshot(
  runtime: HostedRuntimeAdapterPort,
  input: { parentSessionId: string; continuityMode: ScheduleContinuityMode },
): ScheduleContinuationSnapshot {
  if (input.continuityMode !== "inherit") {
    return {
      taskSpec: null,
      claims: [],
      parentAnchor: null,
    };
  }

  const parentAnchor = getRuntimeTapeStatus(runtime, input.parentSessionId).lastAnchor;
  const parentTask = getRuntimeTaskState(runtime, input.parentSessionId);
  const parentClaim = getRuntimeClaimState(runtime, input.parentSessionId);
  return {
    taskSpec: parentTask.spec ?? null,
    claims: parentClaim.claims.map((fact: OperationalClaim) => structuredClone(fact)),
    parentAnchor: hasScheduleContinuationAnchorMetadata(parentAnchor) ? parentAnchor : null,
  };
}

export function buildSchedulePromptTrigger(input: {
  continuityMode: ScheduleContinuityMode;
  snapshot: ScheduleContinuationSnapshot;
  intent: Pick<ScheduleIntentProjectionRecord, "intentId" | "parentSessionId" | "origin">;
}): SchedulePromptTrigger {
  // The intent identity travels with every schedule turn (both continuity
  // modes) so a WAL replay can re-resolve the approval envelope from current
  // config. `origin` is carried verbatim — only the daemon ever stamps it.
  const intent: ScheduleIntentIdentity = {
    intentId: input.intent.intentId,
    parentSessionId: input.intent.parentSessionId,
    ...(input.intent.origin ? { origin: input.intent.origin } : {}),
  };
  if (input.continuityMode !== "inherit") {
    return {
      kind: "schedule",
      continuityMode: input.continuityMode,
      intent,
    };
  }

  return {
    kind: "schedule",
    continuityMode: input.continuityMode,
    intent,
    taskSpec: input.snapshot.taskSpec,
    claims: input.snapshot.claims,
    parentAnchor: input.snapshot.parentAnchor,
  };
}

export function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  snapshot: ScheduleContinuationSnapshot;
}): string {
  const lines = ["[Schedule Wakeup]", `reason: ${input.intent.reason}`];

  if (input.intent.continuityMode === "fresh") {
    lines.push("Run this pass fresh. Prior task and claim state are not preloaded.");
  }
  if (input.snapshot.taskSpec) {
    lines.push(`task_goal: ${clampText(input.snapshot.taskSpec.goal, 320) ?? "none"}`);
  }
  const anchorSummary = clampText(input.snapshot.parentAnchor?.summary, 320);
  if (anchorSummary) {
    lines.push(`parent_anchor_summary: ${anchorSummary}`);
  }
  const nextSteps = clampText(input.snapshot.parentAnchor?.nextSteps, 320);
  if (nextSteps) {
    lines.push(`parent_anchor_next_steps: ${nextSteps}`);
  }

  lines.push("Continue from the recorded schedule intent and make concrete progress.");
  return lines.join("\n");
}

export async function executeScheduleIntentRun(input: {
  runtime: HostedRuntimeAdapterPort;
  backend: SessionBackend;
  intent: ScheduleIntentProjectionRecord;
  cwd?: string;
  configPath?: string;
  model?: string;
  managedToolMode?: ManagedToolMode;
  approvalMode?: ScheduleApprovalMode;
}): Promise<{ evaluationSessionId: string; workerSessionId: string }> {
  const runIndex = input.intent.runCount + 1;
  const workerSessionId = buildScheduleWorkerSessionId({
    intentId: input.intent.intentId,
    runIndex,
  });
  const snapshot = collectScheduleContinuationSnapshot(input.runtime, {
    parentSessionId: input.intent.parentSessionId,
    continuityMode: input.intent.continuityMode,
  });
  const opened = await input.backend.openSession({
    sessionId: workerSessionId,
    cwd: input.cwd,
    configPath: input.configPath,
    model: input.model,
    managedToolMode: input.managedToolMode,
  });
  const agentSessionId = opened.agentSessionId?.trim() || workerSessionId;
  const wakeupMessage = buildScheduleWakeupMessage({
    intent: input.intent,
    snapshot,
  });
  const trigger = buildSchedulePromptTrigger({
    continuityMode: input.intent.continuityMode,
    snapshot,
    intent: input.intent,
  });

  recordRuntimeScheduleWakeup(input.runtime, agentSessionId, {
    schema: "brewva.schedule-wakeup.v1",
    intentId: input.intent.intentId,
    parentSessionId: input.intent.parentSessionId,
    runIndex,
    reason: input.intent.reason,
    continuityMode: input.intent.continuityMode,
    timeZone: input.intent.timeZone ?? null,
    goalRef: input.intent.goalRef ?? null,
    inheritedTaskSpec: snapshot.taskSpec !== null,
    inheritedOperationalClaims: snapshot.claims.length,
    parentAnchorId: snapshot.parentAnchor?.id ?? null,
  });
  recordRuntimeScheduleChildStarted(input.runtime, input.intent.parentSessionId, {
    intentId: input.intent.intentId,
    childSessionId: agentSessionId,
    runIndex,
  });

  try {
    const result = await input.backend.sendPrompt(workerSessionId, wakeupMessage, {
      waitForCompletion: true,
      source: "schedule",
      trigger,
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
    });
    const evaluationSessionId = result.agentSessionId?.trim() || agentSessionId;
    recordRuntimeScheduleChildFinished(input.runtime, input.intent.parentSessionId, {
      intentId: input.intent.intentId,
      childSessionId: evaluationSessionId,
      runIndex,
    });
    return {
      evaluationSessionId,
      workerSessionId,
    };
  } catch (error) {
    recordRuntimeScheduleChildFailed(input.runtime, input.intent.parentSessionId, {
      intentId: input.intent.intentId,
      childSessionId: agentSessionId,
      runIndex,
      error: toErrorMessage(error),
    });
    throw error;
  } finally {
    await input.backend.stopSession(workerSessionId, "schedule_run_complete").catch(() => false);
  }
}
