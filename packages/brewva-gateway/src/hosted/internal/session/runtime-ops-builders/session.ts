import {
  projectSessionForks,
  WORKER_RESULT_RECORDED_EVENT_TYPE,
  type WorkerMergeReport,
} from "@brewva/brewva-vocabulary/delegation";
import { RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND } from "@brewva/brewva-vocabulary/events";
import { PROVIDER_CREDENTIAL_ROTATED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  buildSessionRewindProjection,
  listSessionRewindTargets,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TITLE_GENERATED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import {
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/task";
import {
  executeRedo,
  executeRewind,
  previewWorkspaceRewind,
  recordRewindCheckpoint,
  worldDiffForCheckpoint,
} from "../recovery/rewind-engine.js";
import { projectRewindState } from "../recovery/rewind-state.js";
import { rememberCommittedCompactionContextState } from "../runtime-ops-compaction-state.js";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";
import { readStringArrayRecord } from "./runtime-ops-projections.js";
import { lineageTreeFor, listContextEntryPath } from "./session-lineage.js";
export function buildSessionRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["session"] {
  return {
    state: {
      clear(sessionId) {
        // Durable state is pure-from-tape (no cache to drop); only performance-only
        // Maps are session-scoped in-memory and cleared here.
        for (const map of [
          ctx.state.taskProgressAt,
          ctx.state.latestContextEvidence,
          ctx.state.latestContextUsage,
          ctx.state.latestCompactionGateStatus,
          ctx.state.pendingContextCompactionReasons,
          ctx.state.contextPredictedGrowthEmaTokens,
          ctx.state.contextTurnIndexes,
          ctx.state.activeTaskStalls,
        ]) {
          map.delete(sessionId);
        }
        for (const listener of ctx.state.clearListeners) listener(sessionId);
      },
      onClear(listener) {
        ctx.state.clearListeners.add(listener);
        return () => ctx.state.clearListeners.delete(listener);
      },
    },
    credentials: {
      resolveBindings: () => ({}),
    },
    lifecycle: {
      agentStarted: ctx.recordSemanticEvent("agent_started"),
      agentEnded: ctx.recordSemanticEvent("agent_ended"),
      beforeCompact: ctx.recordSemanticEvent("before_compact"),
      bootstrap: ctx.recordSemanticEvent("session_bootstrap"),
      branchSummaryRecorded: ctx.recordSemanticEvent("branch_summary_recorded"),
      compactFailed: ctx.recordSemanticEvent("compact_failed"),
      compactRequestFailed: ctx.recordSemanticEvent("compact_request_failed"),
      compactRequested: ctx.recordSemanticEvent("compact_requested"),
      getHydration: (sessionId) => ctx.projections.hydration(sessionId),
      getIntegrity: (sessionId) => ctx.projections.integrity(sessionId),
      getOpenToolCalls: () => [],
      getUncleanShutdownDiagnostic: () => undefined,
      inputObserved: ctx.recordSemanticEvent("session_input_observed"),
      messageStarted: ctx.recordSemanticEvent("message_start"),
      messageEnded: ctx.recordSemanticEvent("message.end"),
      modelPresetSelected: ctx.recordSemanticEvent("model_preset_select"),
      modelSelected: ctx.recordSemanticEvent("model_select"),
      providerCredentialRotated: ctx.recordSemanticEvent(PROVIDER_CREDENTIAL_ROTATED_EVENT_TYPE),
      shutdown: ctx.recordSemanticEvent(SESSION_SHUTDOWN_EVENT_TYPE),
      started: ctx.recordSemanticEvent("session_started"),
      thinkingLevelSelected: ctx.recordSemanticEvent("thinking_level_select"),
      turnStarted: ctx.recordSemanticEvent("turn_started"),
      turnEnded: ctx.recordSemanticEvent("turn_ended"),
      turnInputRecorded: ctx.recordSemanticEvent(TURN_INPUT_RECORDED_EVENT_TYPE),
      turnRenderCommitted: ctx.recordSemanticEvent(TURN_RENDER_COMMITTED_EVENT_TYPE),
    },
    workerResults: {
      list: (sessionId) => ctx.projections.workerResults(sessionId),
      record(sessionId, value) {
        return ctx.emit(sessionId, WORKER_RESULT_RECORDED_EVENT_TYPE, { value });
      },
      clear(sessionId, input) {
        // Emit-only: the cleared event carries the workerIds, and the projection's
        // fold applies the removal on read. No cache to keep in sync.
        const workerIds = readStringArrayRecord(input, "workerIds");
        return ctx.emit(sessionId, "worker.results.cleared", {
          workerIds,
          decision:
            input && typeof input === "object" && "decision" in input ? input.decision : undefined,
          reason:
            input && typeof input === "object" && "reason" in input ? input.reason : undefined,
        });
      },
      merge(sessionId, value) {
        const workerIds = readStringArrayRecord(value, "workerIds");
        const stored = ctx.projections.workerResults(sessionId);
        const report: WorkerMergeReport =
          stored.length === 0
            ? { status: "empty", workerIds }
            : { status: "ready", workerIds, mergedPatchSet: undefined };
        ctx.emit(sessionId, "worker.results.merged", report);
        return report;
      },
    },
    title: {
      // Tape-authoritative: guard and replay listing read the generator's receipt.
      get(sessionId) {
        const payload = ctx.latestRecordedPayload(sessionId, SESSION_TITLE_GENERATED_EVENT_TYPE);
        const title = payload && "title" in payload ? payload.title : undefined;
        return typeof title === "string" && title.trim().length > 0 ? title : undefined;
      },
      recordGenerated(sessionId, payload) {
        return ctx.emit(sessionId, SESSION_TITLE_GENERATED_EVENT_TYPE, payload);
      },
    },
    lineage: {
      getNode(sessionId, lineageNodeId) {
        return (
          lineageTreeFor(ctx, sessionId).nodes.find(
            (node) => node.lineageNodeId === lineageNodeId,
          ) ?? undefined
        );
      },
      getTree: (sessionId) => lineageTreeFor(ctx, sessionId),
      listChildren(sessionId, lineageNodeId) {
        const tree = lineageTreeFor(ctx, sessionId);
        const childIds = new Set(
          tree.edges
            .filter((edge) => edge.parentLineageNodeId === lineageNodeId)
            .map((edge) => edge.childLineageNodeId),
        );
        return tree.nodes.filter((node) => childIds.has(node.lineageNodeId));
      },
      getContextEntryPath: (sessionId, query) =>
        listContextEntryPath(
          ctx,
          sessionId,
          query && typeof query === "object" && !Array.isArray(query) ? query : {},
        ),
      createNode(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.node.created", payload);
      },
      recordSummary(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.summary.recorded", payload);
      },
      recordContextEntry(sessionId, payload) {
        return ctx.emit(sessionId, "context.entry.recorded", payload);
      },
      recordCapabilityState(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.capability-state.recorded", payload);
      },
      recordSelection(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.selection.recorded", payload);
      },
      recordOutcome(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.outcome.recorded", payload);
      },
      adoptOutcome(sessionId, payload) {
        return ctx.emit(sessionId, "session.lineage.outcome.adopted", payload);
      },
    },
    compaction: {
      commit(sessionId, payload) {
        rememberCommittedCompactionContextState(ctx, sessionId, payload);
        return ctx.emit(sessionId, RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND, payload);
      },
    },
    mcp: {
      serverConnected: ctx.recordInputPayload("mcp_server_connected"),
      serverDisconnected: ctx.recordInputPayload("mcp_server_disconnected"),
      toolListRefreshed: ctx.recordInputPayload("mcp_tool_list_refreshed"),
      toolCallFailed: ctx.recordInputPayload("mcp_tool_call_failed"),
    },
    rewind: {
      getState: (sessionId) => projectRewindState(sessionId, ctx.listEvents(sessionId)),
      listTargets: (sessionId) => [
        ...listSessionRewindTargets(
          buildSessionRewindProjection({ sessionId, events: ctx.listEvents(sessionId) }),
        ),
      ],
      workspaceReadiness: (sessionId, checkpointId) =>
        previewWorkspaceRewind(ctx, sessionId, checkpointId),
      worldDiff: (sessionId, checkpointId) => worldDiffForCheckpoint(ctx, sessionId, checkpointId),
      worldForks: (sessionId) => [...projectSessionForks(ctx.listEvents(sessionId))],
      recordCheckpoint: (sessionId, input) => recordRewindCheckpoint(ctx, sessionId, input),
      rewind: (sessionId, input) => executeRewind(ctx, sessionId, input),
      redo: (sessionId, input) => executeRedo(ctx, sessionId, input),
    },
    stall: {
      poll(sessionId, inputValue) {
        // Tape-authoritative: a TaskSpec persisted by a prior process must still
        // arm stall detection after a restart (the projection reads the tape).
        if (!ctx.projections.taskSpec(sessionId)) return undefined;
        const now = inputValue.now ?? Date.now();
        const baselineProgressAt = ctx.state.taskProgressAt.get(sessionId) ?? now;
        ctx.state.taskProgressAt.set(sessionId, baselineProgressAt);
        const thresholdMs = Math.max(1, Math.trunc(inputValue.thresholdMs ?? 300_000));
        const idleMs = Math.max(0, now - baselineProgressAt);
        if (idleMs <= thresholdMs || ctx.state.activeTaskStalls.has(sessionId)) {
          return undefined;
        }
        const payload = {
          schema: "brewva.task-watchdog.v1",
          thresholdMs,
          baselineProgressAt,
          detectedAt: now,
          idleMs,
          openItemCount: ctx.projections.taskItems(sessionId).length,
        };
        ctx.state.activeTaskStalls.set(sessionId, payload);
        return ctx.emit(sessionId, TASK_STUCK_DETECTED_EVENT_TYPE, payload, { timestamp: now });
      },
    },
    taskWatchdog: {
      adjudicated: ctx.recordSemanticEvent(TASK_STALL_ADJUDICATED_EVENT_TYPE),
      adjudicationError: ctx.recordSemanticEvent(TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE),
    },
  };
}
