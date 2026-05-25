import { randomUUID } from "node:crypto";
import { getToolActionPolicy } from "@brewva/brewva-runtime/security";
import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-vocabulary/wire";
import {
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_PATCH_PREPARED_EVENT_TYPE,
  SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE,
  SOURCE_RESOURCE_READ_EVENT_TYPE,
  SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildToolsRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["tools"] {
  return {
    access: {
      getActionPolicy: (toolName: string) => getToolActionPolicy(toolName),
      check: (sessionId: string, toolName: string, args?: Record<string, unknown>) =>
        ctx.evaluateRuntimeToolAccess({ sessionId, toolName, args }),
      explain: (input) => ctx.explainRuntimeToolAccess(input),
    },
    invocation: {
      start(inputValue) {
        const access = inputValue.runtimeCapabilityAccess;
        const allowed = access?.allowed ?? true;
        const event = ctx.emit(inputValue.sessionId ?? "default", "tool.invocation.started", {
          ...inputValue,
          allowed,
          ...(access?.reason ? { reason: access.reason } : {}),
          ...(access?.advisory ? { advisory: access.advisory } : {}),
        });
        return {
          ...event,
          allowed,
          ...(access?.reason ? { reason: access.reason } : {}),
          ...(access?.advisory ? { advisory: access.advisory } : {}),
        };
      },
      finish(inputValue) {
        const payload = ctx.readObjectPayload(inputValue);
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "default";
        return ctx.emit(sessionId, "tool.invocation.finished", payload);
      },
      recordResult(inputValue) {
        const payload = ctx.readObjectPayload(inputValue);
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "default";
        return ctx.emit(sessionId, "tool.result.recorded", payload);
      },
    },
    lifecycle: {
      callObserved: ctx.recordInputPayload("tool_call_observed"),
      callBlocked: ctx.recordInputPayload("tool_call_blocked"),
      boxReleased: ctx.recordInputPayload("tool_box_released"),
      executionStarted: ctx.recordInputPayload("tool_execution_started"),
      executionEnded: ctx.recordInputPayload("tool_execution_ended"),
      parallelRead: ctx.recordInputPayload("tool_parallel_read"),
    },
    execution: {
      recordAudit: ctx.recordInputPayload("tool_execution_audit"),
    },
    observability: {
      assertionRecorded: ctx.recordInputPayload("tool_assertion_recorded"),
      queryExecuted: ctx.recordInputPayload("tool_query_executed"),
    },
    operatorQuestions: {
      answerRecorded: ctx.recordInputPayload(OPERATOR_QUESTION_ANSWERED_EVENT_TYPE),
      asked: ctx.recordInputPayload("operator.question.asked"),
      resolved: ctx.recordInputPayload("operator.question.resolved"),
    },
    surface: {
      recordResolved(sessionId, payload) {
        return ctx.emit(sessionId, "tool.surface.resolved", payload);
      },
    },
    capabilitySelection: {
      latest: (sessionId: string) =>
        ctx.latestRecordedPayload(sessionId, "tool.capability.selected"),
      record(sessionId, payload) {
        return ctx.emit(sessionId, "tool.capability.selected", payload);
      },
    },
    parallel: {
      acquire: () => ({ accepted: true }),
      acquireAsync: async () => ({ accepted: true }),
      release: () => undefined,
    },
    resourceLeases: {
      request(sessionId, input) {
        const now = Date.now();
        const lease: ResourceLeaseRecord = {
          id: randomUUID(),
          status: "active",
          budget: input.budget,
          reason: input.reason,
          expiresAt:
            typeof input.ttlMs === "number"
              ? new Date(now + Math.max(0, input.ttlMs)).toISOString()
              : null,
          expiresAfterTurn: typeof input.ttlTurns === "number" ? input.ttlTurns : null,
        };
        ctx.state.resourceLeases.set(sessionId, [
          ...(ctx.state.resourceLeases.get(sessionId) ?? []),
          lease,
        ]);
        ctx.emit(sessionId, "resource_lease_requested", { lease });
        return { ok: true, lease };
      },
      cancel(sessionId, leaseId, reason) {
        const leases = ctx.state.resourceLeases.get(sessionId) ?? [];
        const lease = leases.find((entry) => entry.id === leaseId);
        if (!lease) {
          return { ok: false, reason: "not_found" };
        }
        const cancelledLease: ResourceLeaseRecord = {
          ...lease,
          status: "cancelled",
          reason: reason ?? lease.reason,
        };
        ctx.state.resourceLeases.set(
          sessionId,
          leases.map((entry) => (entry.id === leaseId ? cancelledLease : entry)),
        );
        ctx.emit(sessionId, "resource_lease_cancelled", { lease: cancelledLease, reason });
        return { ok: true, lease: cancelledLease };
      },
      list: (sessionId) => ctx.state.resourceLeases.get(sessionId) ?? [],
    },
    patches: {
      rollbackLastPatchSet: () => ({
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "not_available",
      }),
      redoLastPatchSet: () => ({ ok: false, reason: "not_available" }),
      rollbackLastMutation: () => ({ ok: false, reason: "not_available" }),
    },
    sourcePatch: {
      snapshots: {
        record(sessionId, inputValue) {
          return ctx.emit(sessionId, SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE, inputValue);
        },
      },
      plans: {
        prepare(sessionId, inputValue) {
          return ctx.emit(sessionId, SOURCE_PATCH_PREPARED_EVENT_TYPE, inputValue);
        },
        apply: ctx.recordSessionPayload(SOURCE_PATCH_APPLIED_EVENT_TYPE),
      },
      staleRecovery: {
        record(sessionId, inputValue) {
          return ctx.emit(sessionId, SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE, inputValue);
        },
      },
      resources: {
        read: ctx.recordSessionPayload(SOURCE_RESOURCE_READ_EVENT_TYPE),
      },
    },
    readPath: {
      discoveryObserved: ctx.recordInputPayload("tool_read_path_discovery_observed"),
      gateArmed: ctx.recordInputPayload("tool_read_path_gate_armed"),
      contractWarning: ctx.recordInputPayload("tool_read_path_contract_warning"),
    },
    steering: {
      queued: ctx.recordSemanticEvent("tool_steering_queued"),
      applied: ctx.recordSemanticEvent("tool_steering_applied"),
      dropped: ctx.recordSemanticEvent("tool_steering_dropped"),
    },
    tracking: {
      markCall(sessionId, inputValue): void {
        ctx.emit(sessionId, "tool_call_marked", ctx.readObjectPayload(inputValue));
      },
      trackCallStart: ctx.recordInputPayload("tool_call_started"),
      trackCallEnd: ctx.recordInputPayload("tool_call_ended"),
    },
    outputs: {
      observed: ctx.recordInputPayload("tool_output_observed"),
      distilled: ctx.recordInputPayload("tool_output_distilled"),
      artifactPersisted: ctx.recordInputPayload("tool_output_artifact_persisted"),
      artifactPersistFailed: ctx.recordInputPayload("tool_output_artifact_persist_failed"),
      search: ctx.recordInputPayload("tool_output_search"),
      sourceIntelligenceQuery: ctx.recordInputPayload("tool_source_intelligence"),
    },
    recall: {
      curationRecorded: ctx.recordInputPayload(RECALL_CURATION_RECORDED_EVENT_TYPE),
      resultsSurfaced: ctx.recordInputPayload(RECALL_RESULTS_SURFACED_EVENT_TYPE),
    },
    undo: {
      resolveSessionId: (sessionId: string) => sessionId,
    },
  };
}
