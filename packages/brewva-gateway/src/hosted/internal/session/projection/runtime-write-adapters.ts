import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type {
  TurnInputRecordedPayload,
  TurnRenderCommittedPayload,
} from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";

// The turn envelope drives every production turn (managed session, worker,
// delegation, channels) but may also run against a bare runtime with no ops
// facade — or a partial test facade without the session namespace — so every
// step is optional and receipts are then intentionally skipped.
type OptionalOpsRuntime = {
  readonly ops?: {
    readonly session?: {
      readonly lifecycle?: Partial<
        Pick<
          HostedRuntimeAdapterPort["ops"]["session"]["lifecycle"],
          "turnInputRecorded" | "turnRenderCommitted"
        >
      >;
    };
  };
};

export function recordRuntimeTurnInputReceipt(
  runtime: OptionalOpsRuntime,
  input: {
    readonly sessionId: string;
    readonly runtimeTurn: number;
    readonly payload: TurnInputRecordedPayload;
  },
): void {
  runtime.ops?.session?.lifecycle?.turnInputRecorded?.({
    sessionId: input.sessionId,
    turn: input.runtimeTurn,
    payload: input.payload,
  });
}

export function recordRuntimeTurnRenderReceipt(
  runtime: OptionalOpsRuntime,
  input: {
    readonly sessionId: string;
    readonly runtimeTurn: number;
    readonly payload: TurnRenderCommittedPayload;
  },
): void {
  runtime.ops?.session?.lifecycle?.turnRenderCommitted?.({
    sessionId: input.sessionId,
    turn: input.runtimeTurn,
    payload: input.payload,
  });
}

export function recordRuntimeContinuationAnchor(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tape"]["handoff"]["record"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tape"]["handoff"]["record"]> {
  return runtime.ops.tape.handoff.record(sessionId, input);
}

export function recordRuntimeTurnRewindCheckpoint(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["recordCheckpoint"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["recordCheckpoint"]> {
  return runtime.ops.session.rewind.recordCheckpoint(sessionId, input);
}

export function commitRuntimeSessionCompaction(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["compaction"]["commit"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["compaction"]["commit"]> {
  return runtime.ops.session.compaction.commit(sessionId, input);
}

export function createRuntimeLineageNode(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["createNode"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["createNode"]> {
  return runtime.ops.session.lineage.createNode(sessionId, input);
}

export function recordRuntimeLineageSummary(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordSummary"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordSummary"]> {
  return runtime.ops.session.lineage.recordSummary(sessionId, input);
}

export function recordRuntimeLineageContextEntry(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordContextEntry"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordContextEntry"]> {
  return runtime.ops.session.lineage.recordContextEntry(sessionId, input);
}

export function recordRuntimeGeneratedTitle(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["title"]["recordGenerated"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["title"]["recordGenerated"]> {
  return runtime.ops.session.title.recordGenerated(sessionId, input);
}

export function recordRuntimeAssistantCost(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["cost"]["usage"]["recordAssistant"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["cost"]["usage"]["recordAssistant"]> {
  return runtime.ops.cost.usage.recordAssistant(input);
}

export function startRuntimeToolInvocation(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["start"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["start"]> {
  return runtime.ops.tools.invocation.start(input);
}

export function finishRuntimeToolInvocation(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["finish"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["finish"]> {
  return runtime.ops.tools.invocation.finish(input);
}

export function recordRuntimeToolResult(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["recordResult"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["invocation"]["recordResult"]> {
  return runtime.ops.tools.invocation.recordResult(input);
}

export function recordRuntimeReasoningCheckpoint(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["reasoning"]["checkpoints"]["record"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["reasoning"]["checkpoints"]["record"]> {
  return runtime.ops.reasoning.checkpoints.record(sessionId, input);
}

export function recordRuntimeGoalContinuationQueued(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["goal"]["continuation"]["recordQueued"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["goal"]["continuation"]["recordQueued"]> {
  return runtime.ops.goal.continuation.recordQueued(sessionId, input);
}

export function queryRuntimeEventRecords(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  query: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["records"]["query"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["query"]> {
  return runtime.ops.events.records.query(sessionId, query);
}

export function recordHostedRuntimeEvent(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: {
    sessionId: string;
    type: string;
    payload?: object;
    turn?: number;
    timestamp?: number;
  },
): BrewvaEventRecord | undefined {
  const event = {
    sessionId: input.sessionId,
    payload: input.payload ?? {},
    ...(typeof input.turn === "number" ? { turn: input.turn } : {}),
    ...(typeof input.timestamp === "number" ? { timestamp: input.timestamp } : {}),
  };
  if (input.type === "message_end" || input.type === "message.end") {
    return runtime.ops.session.lifecycle.messageEnded(event);
  }
  if (
    input.type === "thinking_level_selected" ||
    input.type === "thinking_level_select" ||
    input.type === "thinking_level.selected" ||
    input.type === "thinking_level.select"
  ) {
    return runtime.ops.session.lifecycle.thinkingLevelSelected(event);
  }
  if (
    input.type === "model_select" ||
    input.type === "model.select" ||
    input.type === "model.selected"
  ) {
    return runtime.ops.session.lifecycle.modelSelected(event);
  }
  if (
    input.type === "model_preset_select" ||
    input.type === "model_preset.select" ||
    input.type === "model_preset.selected"
  ) {
    return runtime.ops.session.lifecycle.modelPresetSelected(event);
  }
  if (
    input.type === "session_branch_summary_recorded" ||
    input.type === "branch_summary_recorded" ||
    input.type === "session.branch_summary_recorded" ||
    input.type === "branch.summary_recorded"
  ) {
    return runtime.ops.session.lifecycle.branchSummaryRecorded(event);
  }
  if (
    input.type === "task_stall_adjudicated" ||
    input.type === "task_stall.adjudicated" ||
    input.type === "task.stall.adjudicated"
  ) {
    return runtime.ops.session.taskWatchdog.adjudicated(event);
  }
  if (
    input.type === "task_stall_adjudication_error" ||
    input.type === "task_stall.adjudication_error" ||
    input.type === "task.stall.error"
  ) {
    return runtime.ops.session.taskWatchdog.adjudicationError(event);
  }
  throw new Error(`unsupported_hosted_runtime_semantic_event:${input.type}`);
}
