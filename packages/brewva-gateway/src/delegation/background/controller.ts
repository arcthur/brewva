import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  BrewvaConfig,
  BrewvaHostedRuntimePort,
  BrewvaRuntimeInstance,
} from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { DelegationRunQuery, DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-runtime/delegation";
import type { BrewvaStructuredEvent } from "@brewva/brewva-runtime/events";
import { readWorkerResultsAppliedEventPayload } from "@brewva/brewva-runtime/events";
import type {
  DelegationPacket,
  SubagentCancelResult,
  SubagentRunRequest,
} from "@brewva/brewva-tools/contracts";
import { isProcessAlive } from "../../daemon/api.js";
import { sleep } from "../../utils/async.js";
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
import { ensureDelegationLineageNode, recordDelegationLineageOutcome } from "../lineage.js";
import type { DelegationModelRoutingContext } from "../model-routing.js";
import type { HostedDelegationTarget } from "../targets.js";
import {
  type DetachedSubagentRunSpec,
  listDetachedSubagentLiveStates,
  readDetachedSubagentSpec,
  readDetachedSubagentCancelRequest,
  removeDetachedSubagentCancelRequest,
  removeDetachedSubagentLiveState,
  resolveDetachedSubagentSpecPath,
  writeDetachedSubagentCancelRequest,
  writeDetachedSubagentContextManifest,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentSpec,
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
}

interface DetachedBackgroundControllerOptions {
  runtime: BrewvaRuntimeInstance | BrewvaHostedRuntimePort;
  delegationStore?: HostedDelegationStore;
  configPath?: string;
  modelRouting?: DelegationModelRoutingContext;
  spawnProcess?: (input: {
    modulePath: string;
    specPath: string;
    workspaceRoot: string;
  }) => ChildProcess;
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

function toHostedRuntimePort(
  runtime: BrewvaRuntimeInstance | BrewvaHostedRuntimePort,
): BrewvaHostedRuntimePort {
  return "hosted" in runtime ? runtime.hosted : runtime;
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

function cloneRuntimeConfig(runtime: BrewvaHostedRuntimePort): BrewvaConfig {
  return structuredClone(runtime.config) as BrewvaConfig;
}

function defaultSpawnProcess(input: {
  modulePath: string;
  specPath: string;
  workspaceRoot: string;
}): ChildProcess {
  const child = spawn(process.execPath, [input.modulePath, input.specPath], {
    cwd: input.workspaceRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BREWVA_SUBAGENT_BACKGROUND: "1",
    },
  });
  child.unref();
  return child;
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
  runtime: BrewvaHostedRuntimePort,
  parentSessionId: string,
  predicate: Extract<
    NonNullable<DelegationPacket["completionPredicate"]>,
    { source: "worker_results" }
  >,
): boolean {
  return runtime.inspect.session.workerResults.list(parentSessionId).some((result) => {
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
  runtime: BrewvaHostedRuntimePort;
  parentSessionId: string;
  predicate: NonNullable<DelegationPacket["completionPredicate"]>;
  currentEvent?: BrewvaStructuredEvent;
}): boolean {
  const predicate = input.predicate;
  if (predicate.source === "events") {
    if (input.currentEvent) {
      return matchesEventPredicate(input.currentEvent, input.parentSessionId, predicate);
    }
    return input.runtime.inspect.events.records
      .query(input.parentSessionId, { type: predicate.type })
      .some((event) =>
        matchesEventPredicate(
          input.runtime.inspect.events.records.toStructured(event),
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
  const runtime = toHostedRuntimePort(options.runtime);
  const delegationStore = options.delegationStore ?? new HostedDelegationStore(runtime);
  const modulePath = fileURLToPath(new URL("./runner-main.js", import.meta.url));
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const sendSignal =
    options.sendSignal ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
  const trackedPredicates = new Map<
    string,
    {
      parentSessionId: string;
      predicate: NonNullable<DelegationPacket["completionPredicate"]>;
    }
  >();

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
    runtime.authority.tools.parallel.release(record.parentSessionId, record.runId);
    runtime.extensions.hosted.events.record({
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

  const reconcileLiveState = async (
    record: DelegationRunRecord,
  ): Promise<{ live: boolean; cancelable: boolean; record: DelegationRunRecord }> => {
    const liveState = listDetachedSubagentLiveStates(runtime.identity.workspaceRoot).find(
      (entry) => entry.runId === record.runId && entry.parentSessionId === record.parentSessionId,
    );
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

    const cancelRequest = readDetachedSubagentCancelRequest(
      runtime.identity.workspaceRoot,
      record.runId,
    );
    removeDetachedSubagentLiveState(runtime.identity.workspaceRoot, record.runId);
    removeDetachedSubagentCancelRequest(runtime.identity.workspaceRoot, record.runId);
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
      cancelRequest ? "cancelled" : "failed",
      cancelRequest?.reason ?? "background_runner_exited_before_terminal_event",
    );
    return {
      live: false,
      cancelable: false,
      record: terminal,
    };
  };

  const controller: HostedSubagentBackgroundController = {
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
        runtime.extensions.hosted.events.record({
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

      const parallel = runtime.authority.tools.parallel.acquire(input.parentSessionId, runId);
      if (!parallel.accepted) {
        return writeTerminalFailure(
          initialRecord,
          "failed",
          `parallel_slot_rejected:${parallel.reason ?? "unknown"}`,
        );
      }

      runtime.extensions.hosted.events.record({
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
        schema: "brewva.subagent-run-spec.v7",
        runId,
        parentSessionId: input.parentSessionId,
        workspaceRoot: runtime.identity.workspaceRoot,
        config: cloneRuntimeConfig(runtime),
        configPath: options.configPath,
        delegate,
        target: input.target,
        executionShape: input.executionShape,
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
      writeDetachedSubagentSpec(runtime.identity.workspaceRoot, runId, spec);
      writeDetachedSubagentContextManifest(runtime.identity.workspaceRoot, runId, {
        schema: "brewva.delegation-context-manifest.v1",
        runId,
        delegate,
        resultMode: input.target.resultMode,
        generatedAt: createdAt,
        objective: input.packet.objective,
        contextRefs: input.packet.contextRefs ?? [],
      });

      let child: ChildProcess | undefined;
      try {
        child = spawnProcess({
          modulePath,
          specPath: resolveDetachedSubagentSpecPath(runtime.identity.workspaceRoot, runId),
          workspaceRoot: runtime.identity.workspaceRoot,
        });
      } catch (error) {
        return writeTerminalFailure(
          initialRecord,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      const pid = child.pid ?? 0;
      if (pid <= 0) {
        return writeTerminalFailure(initialRecord, "failed", "background_runner_missing_pid");
      }
      writeDetachedSubagentLiveState(runtime.identity.workspaceRoot, runId, {
        schema: "brewva.subagent-run-live.v1",
        runId,
        parentSessionId: input.parentSessionId,
        delegate,
        pid,
        createdAt,
        updatedAt: createdAt,
        status: "pending",
        label: input.label,
      });
      if (input.packet.completionPredicate) {
        trackedPredicates.set(runId, {
          parentSessionId: input.parentSessionId,
          predicate: input.packet.completionPredicate,
        });
      }
      return cloneDelegationRunRecord(initialRecord);
    },
    async inspectLiveRuns({ parentSessionId, query }) {
      for (const liveState of listDetachedSubagentLiveStates(runtime.identity.workspaceRoot)) {
        if (
          liveState.parentSessionId !== parentSessionId ||
          trackedPredicates.has(liveState.runId)
        ) {
          continue;
        }
        const spec = readDetachedSubagentSpec(runtime.identity.workspaceRoot, liveState.runId);
        if (spec?.packet.completionPredicate) {
          trackedPredicates.set(liveState.runId, {
            parentSessionId,
            predicate: spec.packet.completionPredicate,
          });
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
        return {
          ok: false,
          error: `already_terminal:${existing.status}`,
          run: {
            ...cloneDelegationRunRecord(existing),
            live: false,
            cancelable: false,
          },
        };
      }

      const liveState = listDetachedSubagentLiveStates(runtime.identity.workspaceRoot).find(
        (entry) => entry.runId === runId && entry.parentSessionId === parentSessionId,
      );
      if (!liveState) {
        const reconciled = await reconcileLiveState(existing);
        const run = {
          ...cloneDelegationRunRecord(reconciled.record),
          live: false,
          cancelable: false,
        };
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
      writeDetachedSubagentCancelRequest(runtime.identity.workspaceRoot, runId, {
        schema: "brewva.subagent-cancel-request.v1",
        runId,
        requestedAt: Date.now(),
        reason,
      });
      try {
        sendSignal(liveState.pid, "SIGTERM");
      } catch {}

      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (signal === "SIGKILL" && !isPidAlive(liveState.pid)) {
          break;
        }
        if (signal === "SIGKILL") {
          try {
            sendSignal(liveState.pid, signal);
          } catch {}
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(50);
          const latest = delegationStore.getRun(parentSessionId, runId) ?? existing;
          const reconciled = await reconcileLiveState(latest);
          if (isDelegationRunTerminalStatus(reconciled.record.status)) {
            const run = {
              ...cloneDelegationRunRecord(reconciled.record),
              live: false,
              cancelable: false,
            };
            if (
              reconciled.record.status === "cancelled" ||
              reconciled.record.status === "timeout"
            ) {
              return {
                ok: true,
                run,
              };
            }
            return {
              ok: false,
              error: `cancel_not_observed:${reconciled.record.status}`,
              run,
            };
          }
        }
      }

      const latest = delegationStore.getRun(parentSessionId, runId) ?? existing;
      const reconciled = await reconcileLiveState(latest);
      if (isDelegationRunTerminalStatus(reconciled.record.status)) {
        const run = {
          ...cloneDelegationRunRecord(reconciled.record),
          live: false,
          cancelable: false,
        };
        if (reconciled.record.status === "cancelled" || reconciled.record.status === "timeout") {
          return {
            ok: true,
            run,
          };
        }
        return {
          ok: false,
          error: `cancel_not_observed:${reconciled.record.status}`,
          run,
        };
      }
      return {
        ok: false,
        error: `cancel_timeout:${runId}`,
        run: {
          ...cloneDelegationRunRecord(reconciled.record),
          live: isPidAlive(liveState.pid),
          cancelable: isPidAlive(liveState.pid),
        },
      };
    },
    async cancelSessionRuns(parentSessionId, reason = "parent_session_cleared") {
      const liveStates = listDetachedSubagentLiveStates(runtime.identity.workspaceRoot).filter(
        (entry) => entry.parentSessionId === parentSessionId,
      );
      for (const liveState of liveStates) {
        trackedPredicates.delete(liveState.runId);
        writeDetachedSubagentCancelRequest(runtime.identity.workspaceRoot, liveState.runId, {
          schema: "brewva.subagent-cancel-request.v1",
          runId: liveState.runId,
          requestedAt: Date.now(),
          reason,
        });
        try {
          sendSignal(liveState.pid, "SIGTERM");
        } catch {}
      }
    },
  };
  runtime.inspect.events.records.subscribe((event) => {
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
  return controller;
}
