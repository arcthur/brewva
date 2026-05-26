import type { WorkerMergeReport } from "@brewva/brewva-vocabulary/delegation";
import { PROVIDER_CREDENTIAL_ROTATED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import { readStringArrayRecord } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";
import { lineageTreeFor, listContextEntryPath } from "./session-lineage.js";

export function buildSessionRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["session"] {
  return {
    state: {
      clear(sessionId) {
        ctx.state.taskSpecs.delete(sessionId);
        ctx.state.taskItems.delete(sessionId);
        ctx.state.taskBlockers.delete(sessionId);
        ctx.state.taskProgressAt.delete(sessionId);
        ctx.state.latestContextEvidence.delete(sessionId);
        ctx.state.activeTaskStalls.delete(sessionId);
        ctx.state.workerResults.delete(sessionId);
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
      getHydration: () => ({
        status: "ready",
        hydratedAt: Date.now(),
        latestEventId: null,
        issues: [],
      }),
      getIntegrity: () => ({
        status: "healthy",
        issues: [],
      }),
      getOpenToolCalls: () => [],
      getUncleanShutdownDiagnostic: () => undefined,
      inputObserved: ctx.recordSemanticEvent("session_input_observed"),
      messageStarted: ctx.recordSemanticEvent("message_start"),
      messageEnded: ctx.recordSemanticEvent("message.end"),
      modelPresetSelected: ctx.recordSemanticEvent("model_preset_select"),
      modelSelected: ctx.recordSemanticEvent("model_select"),
      providerCredentialRotated: ctx.recordSemanticEvent(PROVIDER_CREDENTIAL_ROTATED_EVENT_TYPE),
      shutdown: ctx.recordSemanticEvent("session_shutdown"),
      started: ctx.recordSemanticEvent("session_started"),
      thinkingLevelSelected: ctx.recordSemanticEvent("thinking_level_select"),
      turnStarted: ctx.recordSemanticEvent("turn_started"),
      turnEnded: ctx.recordSemanticEvent("turn_ended"),
    },
    workerResults: {
      list: (sessionId) => ctx.state.workerResults.get(sessionId) ?? [],
      record(sessionId, value) {
        const next = ctx.state.workerResults.get(sessionId) ?? [];
        next.push(value);
        ctx.state.workerResults.set(sessionId, next);
        return ctx.emit(sessionId, "worker.result.recorded", { value });
      },
      clear(sessionId, input) {
        const workerIds = readStringArrayRecord(input, "workerIds");
        const selected = new Set(workerIds);
        const retained =
          selected.size === 0
            ? []
            : (ctx.state.workerResults.get(sessionId) ?? []).filter((result, index) => {
                const record = result && typeof result === "object" ? result : {};
                const workerId =
                  typeof record.workerId === "string" ? record.workerId : `worker_${index + 1}`;
                return !selected.has(workerId);
              });
        if (retained.length === 0) ctx.state.workerResults.delete(sessionId);
        else ctx.state.workerResults.set(sessionId, retained);
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
        const stored = ctx.state.workerResults.get(sessionId) ?? [];
        const report: WorkerMergeReport =
          stored.length === 0
            ? { status: "empty", workerIds }
            : { status: "ready", workerIds, mergedPatchSet: undefined };
        ctx.emit(sessionId, "worker.results.merged", report);
        return report;
      },
    },
    title: {
      get: () => undefined,
      recordGenerated(sessionId, payload) {
        return ctx.emit(sessionId, "session.title.generated", payload);
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
        return ctx.emit(sessionId, "session.compaction.committed", payload);
      },
    },
    mcp: {
      serverConnected: ctx.recordInputPayload("mcp_server_connected"),
      serverDisconnected: ctx.recordInputPayload("mcp_server_disconnected"),
      toolListRefreshed: ctx.recordInputPayload("mcp_tool_list_refreshed"),
      toolCallFailed: ctx.recordInputPayload("mcp_tool_call_failed"),
    },
    rewind: {
      getState: () => ({
        checkpoints: [],
        rewindAvailable: false,
        redoAvailable: false,
        redoStack: [],
      }),
      listTargets: () => [],
      recordCheckpoint: ctx.recordSessionPayload("session_rewind_checkpoint"),
      rewind: (_sessionId, input) => ({
        ok: false,
        reason: "no_checkpoint",
        trigger: "rewind",
        mode: input.mode ?? "both",
        summary: input.summary ?? "carry",
      }),
      redo: () => ({ ok: false, reason: "no_redo" }),
    },
    stall: {
      poll(sessionId, inputValue) {
        if (!ctx.state.taskSpecs.has(sessionId)) return undefined;
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
          openItemCount: ctx.state.taskItems.get(sessionId)?.length ?? 0,
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
