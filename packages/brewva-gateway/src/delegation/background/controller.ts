import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type {
  DelegationPacket,
  SubagentCancelResult,
  SubagentRunRequest,
} from "@brewva/brewva-tools/contracts";
import type { DelegationRunQuery, DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-vocabulary/delegation";
import { readWorkerResultsAppliedEventPayload } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaStructuredEvent } from "@brewva/brewva-vocabulary/events";
import { isProcessAlive } from "../../daemon/api.js";
import type { HostedRuntimeAdapterPort } from "../../hosted/api.js";
import {
  acquireRuntimeParallelSlot,
  listRuntimeWorkerResults,
  queryRuntimeEvents,
  releaseRuntimeParallelSlot,
  subscribeRuntimeEvents,
  toStructuredRuntimeEvent,
} from "../../hosted/api.js";
import { sleep } from "../../utils/async.js";
import { buildDelegationContextBundle } from "../build-delegation-context-bundle.js";
import {
  buildDelegationRunRecordSeed,
  buildDelegationTaskIdentity,
} from "../delegation-records.js";
import {
  HostedDelegationStore,
  buildDelegationLifecyclePayload,
  cloneDelegationRunRecord,
} from "../delegation-store.js";
import {
  resolveDelegationExecutionPlan,
  type ResolvedDelegationExecutionPlan,
} from "../execution-plan.js";
import { buildInheritedSubagentContextBlock } from "../fork-context.js";
import { ensureDelegationLineageNode, recordDelegationLineageOutcome } from "../lineage.js";
import type { DelegationModelRoutingContext } from "../model-routing.js";
import { recordDelegationRuntimeEvent } from "../runtime-events.js";
import type { HostedDelegationTarget } from "../targets.js";
import {
  createDetachedRunAdapter,
  type DetachedRunAdapter,
  type DetachedSpawnProcess,
} from "./detached-run-adapter.js";
import type {
  DetachedSubagentCancelRequest,
  DetachedSubagentLiveState,
  DetachedSubagentRunSpec,
} from "./protocol.js";

export interface HostedSubagentBackgroundController {
  startRun(input: {
    parentSessionId: string;
    target: HostedDelegationTarget;
    delegate?: string;
    packet: DelegationPacket;
    executionShape?: SubagentRunRequest["executionShape"];
    label?: string;
    taskName?: string;
    nickname?: string;
    parentTaskPath?: string;
    forkTurns?: SubagentRunRequest["forkTurns"];
    timeoutMs?: number;
    delivery?: NonNullable<SubagentRunRequest["delivery"]>;
  }): Promise<DelegationRunRecord>;
  inspectLiveRuns(input: {
    parentSessionId: string;
    query?: DelegationRunQuery;
  }): Promise<Map<string, { live: boolean; cancelable: boolean }>>;
  cancelRun(input: {
    parentSessionId: string;
    runId: string;
    reason?: string;
  }): Promise<SubagentCancelResult>;
  cancelSessionRuns?(parentSessionId: string, reason?: string): Promise<void>;
  dispose?(): void;
}

interface DetachedBackgroundControllerOptions {
  runtime: HostedRuntimeAdapterPort;
  delegationStore?: HostedDelegationStore;
  configPath?: string;
  modelRouting?: DelegationModelRoutingContext;
  detachedAdapter?: DetachedRunAdapter;
  spawnProcess?: DetachedSpawnProcess;
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

type DetachedRunView = DelegationRunRecord & {
  live: boolean;
  cancelable: boolean;
};

interface DetachedRunInspection {
  live: boolean;
  cancelable: boolean;
  record: DelegationRunRecord;
}

function buildDeliveryRecord(
  delivery: SubagentRunRequest["delivery"] | undefined,
  updatedAt: number,
): DelegationRunRecord["delivery"] {
  return {
    mode: delivery?.returnMode ?? "text_only",
    scopeId: delivery?.returnScopeId,
    label: delivery?.returnLabel,
    handoffState: "none",
    updatedAt,
  };
}

function cloneRuntimeConfig(runtime: HostedRuntimeAdapterPort): BrewvaConfig {
  return structuredClone(runtime.config) as BrewvaConfig;
}

function matchesEventPredicate(
  event: BrewvaStructuredEvent,
  parentSessionId: string,
  predicate: Extract<NonNullable<DelegationPacket["completionPredicate"]>, { source: "events" }>,
): boolean {
  if (event.sessionId !== parentSessionId || event.type !== predicate.type) {
    return false;
  }
  if (!predicate.match) {
    return true;
  }
  const payload =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  return Object.entries(predicate.match).every(([key, value]) => {
    const current = payload[key];
    if (Array.isArray(current)) {
      return current.some((entry) => entry === value);
    }
    return current === value;
  });
}

function matchesWorkerResultPredicate(
  runtime: HostedRuntimeAdapterPort,
  parentSessionId: string,
  predicate: Extract<
    NonNullable<DelegationPacket["completionPredicate"]>,
    { source: "worker_results" }
  >,
): boolean {
  return listRuntimeWorkerResults(runtime, parentSessionId).some((result) => {
    if (predicate.workerId && result.workerId !== predicate.workerId) {
      return false;
    }
    if (predicate.status && result.status !== predicate.status) {
      return false;
    }
    return true;
  });
}

function readEventWorkerIds(event: BrewvaStructuredEvent): string[] {
  return readWorkerResultsAppliedEventPayload(event)?.workerIds ?? [];
}

function evaluateCompletionPredicate(input: {
  runtime: HostedRuntimeAdapterPort;
  parentSessionId: string;
  predicate: NonNullable<DelegationPacket["completionPredicate"]>;
  currentEvent?: BrewvaStructuredEvent;
}): boolean {
  const predicate = input.predicate;
  if (predicate.source === "events") {
    if (input.currentEvent) {
      return matchesEventPredicate(input.currentEvent, input.parentSessionId, predicate);
    }
    return queryRuntimeEvents(input.runtime, input.parentSessionId, { type: predicate.type }).some(
      (event) =>
        matchesEventPredicate(
          toStructuredRuntimeEvent(input.runtime, event),
          input.parentSessionId,
          predicate,
        ),
    );
  }

  if (input.currentEvent && input.currentEvent.sessionId === input.parentSessionId) {
    const appliedWorkerIds = readEventWorkerIds(input.currentEvent);
    if (
      appliedWorkerIds.length > 0 &&
      (!predicate.workerId || appliedWorkerIds.includes(predicate.workerId)) &&
      (!predicate.status || predicate.status === "ok")
    ) {
      return true;
    }
  }

  return matchesWorkerResultPredicate(input.runtime, input.parentSessionId, predicate);
}

export function createDetachedSubagentBackgroundController(
  options: DetachedBackgroundControllerOptions,
): HostedSubagentBackgroundController {
  const runtime = options.runtime;
  const delegationStore = options.delegationStore ?? new HostedDelegationStore(runtime);
  const modulePath = fileURLToPath(new URL("./runner-main.js", import.meta.url));
  const detachedAdapter =
    options.detachedAdapter ??
    createDetachedRunAdapter({
      spawnProcess: options.spawnProcess,
      sendSignal: options.sendSignal,
    });
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const trackedPredicates = new Map<
    string,
    {
      parentSessionId: string;
      predicate: NonNullable<DelegationPacket["completionPredicate"]>;
    }
  >();
  let unsubscribePredicateEvents: (() => void) | undefined;
  let controller: HostedSubagentBackgroundController;

  const installPredicateWatcher = (): void => {
    if (unsubscribePredicateEvents) {
      return;
    }
    unsubscribePredicateEvents = subscribeRuntimeEvents(runtime, (event) => {
      for (const [runId, tracked] of trackedPredicates.entries()) {
        if (tracked.parentSessionId !== event.sessionId) {
          continue;
        }
        const matched = evaluateCompletionPredicate({
          runtime: runtime,
          parentSessionId: tracked.parentSessionId,
          predicate: tracked.predicate,
          currentEvent: event,
        });
        if (!matched) {
          continue;
        }
        void controller.cancelRun({
          parentSessionId: tracked.parentSessionId,
          runId,
          reason: "completion_predicate_satisfied",
        });
      }
    });
  };

  const writeTerminalFailure = (
    record: DelegationRunRecord,
    terminalStatus: Extract<DelegationRunRecord["status"], "failed" | "cancelled">,
    reason: string,
  ): DelegationRunRecord => {
    const updatedAt = Date.now();
    const updated: DelegationRunRecord = {
      ...cloneDelegationRunRecord(record),
      status: terminalStatus,
      updatedAt,
      summary: record.summary ?? reason,
      error: terminalStatus === "failed" ? reason : (record.error ?? reason),
      delivery: record.delivery
        ? {
            ...record.delivery,
            updatedAt,
          }
        : undefined,
    };
    trackedPredicates.delete(record.runId);
    releaseRuntimeParallelSlot(runtime, record.parentSessionId, record.runId);
    recordDelegationRuntimeEvent({
      runtime,
      sessionId: record.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildDelegationLifecyclePayload(updated),
        reason,
      },
    });
    recordDelegationLineageOutcome({
      runtime: runtime,
      sessionId: record.parentSessionId,
      record: updated,
    });
    return updated;
  };

  const toDetachedRunView = (
    record: DelegationRunRecord,
    state: { live: boolean; cancelable: boolean },
  ): DetachedRunView => ({
    ...cloneDelegationRunRecord(record),
    live: state.live,
    cancelable: state.cancelable,
  });

  const buildCancelRequest = (
    runId: string,
    reason: string | undefined,
  ): DetachedSubagentCancelRequest => {
    const request: DetachedSubagentCancelRequest = {
      schema: "brewva.subagent-cancel-request.v1",
      runId,
      requestedAt: Date.now(),
    };
    if (reason) {
      request.reason = reason;
    }
    return request;
  };

  const readLiveState = (
    parentSessionId: string,
    runId: string,
  ): DetachedSubagentLiveState | undefined =>
    detachedAdapter
      .readLiveState({
        workspaceRoot: runtime.identity.workspaceRoot,
        runId,
      })
      .find((entry) => entry.runId === runId && entry.parentSessionId === parentSessionId);

  const requestCancel = (
    liveState: DetachedSubagentLiveState,
    request: DetachedSubagentCancelRequest,
    signal: NodeJS.Signals,
  ): void => {
    detachedAdapter.requestCancel({
      workspaceRoot: runtime.identity.workspaceRoot,
      runId: request.runId,
      request,
      pid: liveState.pid,
      signal,
    });
  };

  const terminalCancelResult = (
    record: DelegationRunRecord,
    failurePrefix: "already_terminal" | "cancel_not_observed",
  ): SubagentCancelResult => {
    const run = toDetachedRunView(record, { live: false, cancelable: false });
    if (failurePrefix === "cancel_not_observed" && record.status === "cancelled") {
      return {
        ok: true,
        run,
      };
    }
    return {
      ok: false,
      error: `${failurePrefix}:${record.status}`,
      run,
    };
  };

  const reconcileLiveState = async (
    record: DelegationRunRecord,
  ): Promise<DetachedRunInspection> => {
    const liveState = readLiveState(record.parentSessionId, record.runId);
    if (!liveState) {
      trackedPredicates.delete(record.runId);
      if (!isDelegationRunTerminalStatus(record.status)) {
        const failed = writeTerminalFailure(record, "failed", "background_registry_missing");
        return {
          live: false,
          cancelable: false,
          record: failed,
        };
      }
      return {
        live: false,
        cancelable: false,
        record,
      };
    }
    if (isPidAlive(liveState.pid)) {
      return {
        live: true,
        cancelable: true,
        record,
      };
    }

    detachedAdapter.cleanup({
      workspaceRoot: runtime.identity.workspaceRoot,
      runId: record.runId,
    });
    trackedPredicates.delete(record.runId);
    if (isDelegationRunTerminalStatus(record.status)) {
      return {
        live: false,
        cancelable: false,
        record,
      };
    }

    const terminal = writeTerminalFailure(
      record,
      liveState.cancelRequestedAt ? "cancelled" : "failed",
      liveState.cancelReason ?? "background_runner_exited_before_terminal_event",
    );
    return {
      live: false,
      cancelable: false,
      record: terminal,
    };
  };

  const waitForCancelTerminalResult = async (input: {
    parentSessionId: string;
    runId: string;
    existing: DelegationRunRecord;
  }): Promise<SubagentCancelResult | undefined> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(50);
      const latest = delegationStore.getRun(input.parentSessionId, input.runId) ?? input.existing;
      const reconciled = await reconcileLiveState(latest);
      if (isDelegationRunTerminalStatus(reconciled.record.status)) {
        return terminalCancelResult(reconciled.record, "cancel_not_observed");
      }
    }
    return undefined;
  };

  controller = {
    async startRun(input) {
      const runId = randomUUID();
      const createdAt = Date.now();
      const delegate =
        input.delegate ??
        input.target.agentSpecName ??
        input.target.envelopeName ??
        input.target.name;
      const taskIdentity = buildDelegationTaskIdentity({
        target: input.target,
        requestedTaskName: input.taskName,
        requestedNickname: input.nickname,
        label: input.label,
        parentTaskPath: input.parentTaskPath,
        reservedTaskPaths: delegationStore
          .listRuns(input.parentSessionId, { includeTerminal: true })
          .map((record) => record.taskPath),
      });
      const forkTurns = input.forkTurns ?? "none";
      let executionPlan: ResolvedDelegationExecutionPlan;
      try {
        executionPlan = resolveDelegationExecutionPlan({
          runtime: runtime,
          target: input.target,
          delegate,
          packet: input.packet,
          executionShape: input.executionShape,
          modelRouting: options.modelRouting,
        });
      } catch (error) {
        return writeTerminalFailure(
          buildDelegationRunRecordSeed({
            runId,
            target: input.target,
            delegate,
            parentSessionId: asBrewvaSessionId(input.parentSessionId),
            status: "failed",
            createdAt,
            updatedAt: createdAt,
            label: input.label,
            taskIdentity,
            forkTurns,
            delivery: buildDeliveryRecord(input.delivery, createdAt),
          }),
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const initialRecord: DelegationRunRecord = buildDelegationRunRecordSeed({
        runId,
        target: input.target,
        delegate,
        parentSessionId: asBrewvaSessionId(input.parentSessionId),
        createdAt,
        label: input.label,
        taskIdentity,
        forkTurns,
        boundary: executionPlan.boundary,
        modelRoute: executionPlan.modelRoute,
        delivery: buildDeliveryRecord(input.delivery, createdAt),
      });
      if (
        input.packet.completionPredicate &&
        evaluateCompletionPredicate({
          runtime: runtime,
          parentSessionId: input.parentSessionId,
          predicate: input.packet.completionPredicate,
        })
      ) {
        const cancelledRecord: DelegationRunRecord = {
          ...cloneDelegationRunRecord(initialRecord),
          status: "cancelled",
          updatedAt: createdAt,
          summary: "completion_predicate_satisfied",
        };
        recordDelegationRuntimeEvent({
          runtime,
          sessionId: input.parentSessionId,
          type: "subagent_cancelled",
          payload: {
            ...buildDelegationLifecyclePayload(cancelledRecord),
            reason: "completion_predicate_satisfied",
          },
        });
        recordDelegationLineageOutcome({
          runtime: runtime,
          sessionId: input.parentSessionId,
          record: cancelledRecord,
        });
        return cloneDelegationRunRecord(cancelledRecord);
      }

      const parallel = acquireRuntimeParallelSlot(runtime, input.parentSessionId, runId);
      if (!parallel.accepted) {
        return writeTerminalFailure(
          initialRecord,
          "failed",
          `parallel_slot_rejected:${parallel.reason ?? "unknown"}`,
        );
      }

      recordDelegationRuntimeEvent({
        runtime,
        sessionId: input.parentSessionId,
        type: "subagent_spawned",
        payload: buildDelegationLifecyclePayload(initialRecord),
      });
      ensureDelegationLineageNode({
        runtime: runtime,
        sessionId: input.parentSessionId,
        record: initialRecord,
      });

      const spec: DetachedSubagentRunSpec = {
        schema: "brewva.subagent-run-spec.v8",
        runId,
        parentSessionId: input.parentSessionId,
        workspaceRoot: runtime.identity.workspaceRoot,
        config: cloneRuntimeConfig(runtime),
        configPath: options.configPath,
        delegate,
        target: input.target,
        executionShape: input.executionShape,
        modelRole: executionPlan.modelRole,
        modelRoute: executionPlan.modelRoute,
        label: input.label,
        taskName: taskIdentity.taskName,
        taskPath: taskIdentity.taskPath,
        nickname: taskIdentity.nickname,
        depth: taskIdentity.depth,
        forkTurns,
        packet: input.packet,
        timeoutMs: input.timeoutMs,
        delivery: input.delivery,
        createdAt,
      };
      let specPath = "";
      try {
        const inheritedBlock = buildInheritedSubagentContextBlock({
          runtime,
          sessionId: input.parentSessionId,
          forkTurns,
        });
        const contextBundleResult = buildDelegationContextBundle({
          packet: input.packet,
          inheritedBlock,
          createdAt,
        });
        if (!contextBundleResult.ok) {
          const blocker = contextBundleResult.blocker;
          const usage = `${blocker.requiredTokens}/${blocker.maxTokens}`;
          throw new Error(`delegation_context_blocked:${blocker.overflow}:${usage}`);
        }
        specPath = detachedAdapter.writeSpec({
          workspaceRoot: runtime.identity.workspaceRoot,
          runId,
          spec,
          contextManifest: {
            schema: "brewva.delegation-context-bundle.v1",
            runId,
            generatedAt: createdAt,
            bundle: contextBundleResult.bundle,
            hash: contextBundleResult.bundle.hash,
          },
        }).specPath;
      } catch (error) {
        try {
          detachedAdapter.cleanup({
            workspaceRoot: runtime.identity.workspaceRoot,
            runId,
          });
        } catch {}
        return writeTerminalFailure(
          initialRecord,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      let child: ReturnType<DetachedRunAdapter["start"]> | undefined;
      try {
        child = detachedAdapter.start({
          modulePath,
          specPath,
          workspaceRoot: runtime.identity.workspaceRoot,
          buildLiveState: (startedChild) => ({
            schema: "brewva.subagent-run-live.v1",
            runId,
            parentSessionId: input.parentSessionId,
            delegate,
            pid: startedChild.pid ?? 0,
            createdAt,
            updatedAt: createdAt,
            status: "pending",
            label: input.label,
            completionPredicate: input.packet.completionPredicate,
          }),
        });
      } catch (error) {
        try {
          detachedAdapter.cleanup({
            workspaceRoot: runtime.identity.workspaceRoot,
            runId,
          });
        } catch {}
        return writeTerminalFailure(
          initialRecord,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      const pid = child.pid ?? 0;
      if (pid <= 0) {
        detachedAdapter.cleanup({
          workspaceRoot: runtime.identity.workspaceRoot,
          runId,
        });
        return writeTerminalFailure(initialRecord, "failed", "background_runner_missing_pid");
      }
      if (input.packet.completionPredicate) {
        trackedPredicates.set(runId, {
          parentSessionId: input.parentSessionId,
          predicate: input.packet.completionPredicate,
        });
        installPredicateWatcher();
      }
      return cloneDelegationRunRecord(initialRecord);
    },
    async inspectLiveRuns({ parentSessionId, query }) {
      for (const liveState of detachedAdapter.readLiveState({
        workspaceRoot: runtime.identity.workspaceRoot,
      })) {
        if (
          liveState.parentSessionId !== parentSessionId ||
          trackedPredicates.has(liveState.runId)
        ) {
          continue;
        }
        if (liveState.completionPredicate) {
          trackedPredicates.set(liveState.runId, {
            parentSessionId,
            predicate: liveState.completionPredicate,
          });
          installPredicateWatcher();
        }
      }
      for (const [runId, tracked] of Array.from(trackedPredicates.entries())) {
        if (tracked.parentSessionId !== parentSessionId) {
          continue;
        }
        if (
          evaluateCompletionPredicate({
            runtime: runtime,
            parentSessionId,
            predicate: tracked.predicate,
          })
        ) {
          await controller.cancelRun({
            parentSessionId,
            runId,
            reason: "completion_predicate_satisfied",
          });
        }
      }
      const runs = delegationStore.listRuns(parentSessionId, query);
      const map = new Map<string, { live: boolean; cancelable: boolean }>();
      for (const run of runs) {
        const inspection = await reconcileLiveState(run);
        map.set(run.runId, {
          live: inspection.live,
          cancelable: inspection.cancelable,
        });
      }
      return map;
    },
    async cancelRun({ parentSessionId, runId, reason }) {
      const existing = delegationStore.getRun(parentSessionId, runId);
      if (!existing) {
        return {
          ok: false,
          error: `unknown_run:${runId}`,
        };
      }
      if (isDelegationRunTerminalStatus(existing.status)) {
        trackedPredicates.delete(runId);
        return terminalCancelResult(existing, "already_terminal");
      }

      const liveState = readLiveState(parentSessionId, runId);
      if (!liveState) {
        const reconciled = await reconcileLiveState(existing);
        const run = toDetachedRunView(reconciled.record, { live: false, cancelable: false });
        if (reconciled.record.status === "cancelled") {
          return {
            ok: true,
            run,
          };
        }
        return {
          ok: false,
          error: `not_live:${runId}`,
          run,
        };
      }

      trackedPredicates.delete(runId);
      const cancelRequest = buildCancelRequest(runId, reason);
      requestCancel(liveState, cancelRequest, "SIGTERM");

      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (signal === "SIGKILL" && !isPidAlive(liveState.pid)) {
          break;
        }
        if (signal === "SIGKILL") {
          requestCancel(liveState, cancelRequest, signal);
        }
        const observed = await waitForCancelTerminalResult({
          parentSessionId,
          runId,
          existing,
        });
        if (observed) {
          return observed;
        }
      }

      const latest = delegationStore.getRun(parentSessionId, runId) ?? existing;
      const reconciled = await reconcileLiveState(latest);
      if (isDelegationRunTerminalStatus(reconciled.record.status)) {
        return terminalCancelResult(reconciled.record, "cancel_not_observed");
      }
      const live = isPidAlive(liveState.pid);
      return {
        ok: false,
        error: `cancel_timeout:${runId}`,
        run: toDetachedRunView(reconciled.record, { live, cancelable: live }),
      };
    },
    async cancelSessionRuns(parentSessionId, reason = "parent_session_cleared") {
      const liveStates = detachedAdapter
        .readLiveState({ workspaceRoot: runtime.identity.workspaceRoot })
        .filter((entry) => entry.parentSessionId === parentSessionId);
      for (const liveState of liveStates) {
        trackedPredicates.delete(liveState.runId);
        requestCancel(liveState, buildCancelRequest(liveState.runId, reason), "SIGTERM");
      }
    },
    dispose() {
      unsubscribePredicateEvents?.();
      unsubscribePredicateEvents = undefined;
      trackedPredicates.clear();
    },
  };
  return controller;
}
