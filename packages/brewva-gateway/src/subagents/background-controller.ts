import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  BrewvaStructuredEvent,
  BrewvaConfig,
  BrewvaRuntime,
  DelegationRunQuery,
  DelegationRunRecord,
  SkillRoutingScope,
} from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentCancelResult,
  SubagentRunRequest,
} from "@brewva/brewva-tools";
import { isProcessAlive } from "../daemon/pid.js";
import { sleep } from "../utils/async.js";
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
} from "./background-protocol.js";
import {
  HostedDelegationStore,
  buildDelegationLifecyclePayload,
  cloneDelegationRunRecord,
} from "./delegation-store.js";
import type { DelegationModelRoutingContext } from "./model-routing.js";
import { resolveDelegationExecutionPlan, type ResolvedDelegationExecutionPlan } from "./shared.js";
import type { HostedDelegationTarget } from "./targets.js";

export interface HostedSubagentBackgroundController {
  startRun(input: {
    parentSessionId: string;
    target: HostedDelegationTarget;
    delegate?: string;
    packet: DelegationPacket;
    executionShape?: SubagentRunRequest["executionShape"];
    label?: string;
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
  runtime: BrewvaRuntime;
  delegationStore?: HostedDelegationStore;
  configPath?: string;
  routingScopes?: SkillRoutingScope[];
  modelRouting?: DelegationModelRoutingContext;
  spawnProcess?: (input: {
    modulePath: string;
    specPath: string;
    workspaceRoot: string;
  }) => ChildProcess;
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
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

function isTerminalStatus(status: DelegationRunRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled" ||
    status === "merged"
  );
}

function cloneRuntimeConfig(runtime: BrewvaRuntime): BrewvaConfig {
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
  return Object.entries(predicate.match).every(([key, value]) => payload[key] === value);
}

function matchesWorkerResultPredicate(
  runtime: BrewvaRuntime,
  parentSessionId: string,
  predicate: Extract<
    NonNullable<DelegationPacket["completionPredicate"]>,
    { source: "worker_results" }
  >,
): boolean {
  return runtime.session.listWorkerResults(parentSessionId).some((result) => {
    if (predicate.workerId && result.workerId !== predicate.workerId) {
      return false;
    }
    if (predicate.status && result.status !== predicate.status) {
      return false;
    }
    return true;
  });
}

export function createDetachedSubagentBackgroundController(
  options: DetachedBackgroundControllerOptions,
): HostedSubagentBackgroundController {
  const delegationStore = options.delegationStore ?? new HostedDelegationStore(options.runtime);
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
    options.runtime.events.record({
      sessionId: record.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildDelegationLifecyclePayload(updated),
        reason,
      },
    });
    return updated;
  };

  const reconcileLiveState = async (
    record: DelegationRunRecord,
  ): Promise<{ live: boolean; cancelable: boolean; record: DelegationRunRecord }> => {
    const liveState = listDetachedSubagentLiveStates(options.runtime.workspaceRoot).find(
      (entry) => entry.runId === record.runId && entry.parentSessionId === record.parentSessionId,
    );
    if (!liveState) {
      trackedPredicates.delete(record.runId);
      if (!isTerminalStatus(record.status)) {
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
      options.runtime.workspaceRoot,
      record.runId,
    );
    removeDetachedSubagentLiveState(options.runtime.workspaceRoot, record.runId);
    removeDetachedSubagentCancelRequest(options.runtime.workspaceRoot, record.runId);
    trackedPredicates.delete(record.runId);
    if (isTerminalStatus(record.status)) {
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
      const parentSkill = options.runtime.skills.getActive(input.parentSessionId)?.name;
      const delegate =
        input.delegate ??
        input.target.agentSpecName ??
        input.target.envelopeName ??
        input.target.name;
      let executionPlan: ResolvedDelegationExecutionPlan;
      try {
        executionPlan = resolveDelegationExecutionPlan({
          runtime: options.runtime,
          target: input.target,
          delegate,
          packet: input.packet,
          executionShape: input.executionShape,
          modelRouting: options.modelRouting,
        });
      } catch (error) {
        return writeTerminalFailure(
          {
            runId,
            delegate,
            agentSpec: input.target.agentSpecName,
            envelope: input.target.envelopeName,
            skillName: input.target.skillName,
            parentSessionId: input.parentSessionId,
            status: "failed",
            createdAt,
            updatedAt: createdAt,
            label: input.label,
            parentSkill,
            kind: input.target.resultMode,
            delivery: buildDeliveryRecord(input.delivery, createdAt),
          },
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const initialRecord: DelegationRunRecord = {
        runId,
        delegate,
        agentSpec: input.target.agentSpecName,
        envelope: input.target.envelopeName,
        skillName: input.target.skillName,
        parentSessionId: input.parentSessionId,
        status: "pending",
        createdAt,
        updatedAt: createdAt,
        label: input.label,
        parentSkill,
        kind: input.target.resultMode,
        boundary: executionPlan.boundary,
        modelRoute: executionPlan.modelRoute,
        delivery: buildDeliveryRecord(input.delivery, createdAt),
      };
      options.runtime.events.record({
        sessionId: input.parentSessionId,
        type: "subagent_spawned",
        payload: buildDelegationLifecyclePayload(initialRecord),
      });

      const spec: DetachedSubagentRunSpec = {
        schema: "brewva.subagent-run-spec.v6",
        runId,
        parentSessionId: input.parentSessionId,
        workspaceRoot: options.runtime.workspaceRoot,
        config: cloneRuntimeConfig(options.runtime),
        configPath: options.configPath,
        routingScopes: options.routingScopes,
        delegate,
        target: input.target,
        skillName: input.target.skillName,
        envelopeName: input.target.envelopeName,
        agentSpecName: input.target.agentSpecName,
        fallbackResultMode: input.target.fallbackResultMode,
        executionShape: input.executionShape,
        modelRoute: executionPlan.modelRoute,
        label: input.label,
        packet: input.packet,
        timeoutMs: input.timeoutMs,
        delivery: input.delivery,
        createdAt,
      };
      writeDetachedSubagentSpec(options.runtime.workspaceRoot, runId, spec);
      writeDetachedSubagentContextManifest(options.runtime.workspaceRoot, runId, {
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
          specPath: resolveDetachedSubagentSpecPath(options.runtime.workspaceRoot, runId),
          workspaceRoot: options.runtime.workspaceRoot,
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
      writeDetachedSubagentLiveState(options.runtime.workspaceRoot, runId, {
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
        const alreadyMatched =
          input.packet.completionPredicate.source === "events"
            ? options.runtime.events
                .query(input.parentSessionId, { type: input.packet.completionPredicate.type })
                .some((event) =>
                  matchesEventPredicate(
                    options.runtime.events.toStructured(event),
                    input.parentSessionId,
                    input.packet.completionPredicate as Extract<
                      NonNullable<DelegationPacket["completionPredicate"]>,
                      { source: "events" }
                    >,
                  ),
                )
            : matchesWorkerResultPredicate(
                options.runtime,
                input.parentSessionId,
                input.packet.completionPredicate,
              );
        if (alreadyMatched) {
          void controller.cancelRun({
            parentSessionId: input.parentSessionId,
            runId,
            reason: "completion_predicate_satisfied",
          });
        }
      }
      return cloneDelegationRunRecord(initialRecord);
    },
    async inspectLiveRuns({ parentSessionId, query }) {
      for (const liveState of listDetachedSubagentLiveStates(options.runtime.workspaceRoot)) {
        if (
          liveState.parentSessionId !== parentSessionId ||
          trackedPredicates.has(liveState.runId)
        ) {
          continue;
        }
        const spec = readDetachedSubagentSpec(options.runtime.workspaceRoot, liveState.runId);
        if (spec?.packet.completionPredicate) {
          trackedPredicates.set(liveState.runId, {
            parentSessionId,
            predicate: spec.packet.completionPredicate,
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
      if (isTerminalStatus(existing.status)) {
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

      const liveState = listDetachedSubagentLiveStates(options.runtime.workspaceRoot).find(
        (entry) => entry.runId === runId && entry.parentSessionId === parentSessionId,
      );
      if (!liveState) {
        const reconciled = await reconcileLiveState(existing);
        return {
          ok: reconciled.record.status === "cancelled",
          error: reconciled.record.status === "cancelled" ? undefined : `not_live:${runId}`,
          run: {
            ...cloneDelegationRunRecord(reconciled.record),
            live: false,
            cancelable: false,
          },
        };
      }

      trackedPredicates.delete(runId);
      writeDetachedSubagentCancelRequest(options.runtime.workspaceRoot, runId, {
        schema: "brewva.subagent-cancel-request.v1",
        runId,
        requestedAt: Date.now(),
        reason,
      });
      try {
        sendSignal(liveState.pid, "SIGTERM");
      } catch {
        // reconciliation below will convert missing live pid into terminal state.
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(50);
        const latest = delegationStore.getRun(parentSessionId, runId) ?? existing;
        const reconciled = await reconcileLiveState(latest);
        if (isTerminalStatus(reconciled.record.status)) {
          return {
            ok: reconciled.record.status === "cancelled" || reconciled.record.status === "timeout",
            error:
              reconciled.record.status === "cancelled" || reconciled.record.status === "timeout"
                ? undefined
                : `cancel_not_observed:${reconciled.record.status}`,
            run: {
              ...cloneDelegationRunRecord(reconciled.record),
              live: false,
              cancelable: false,
            },
          };
        }
      }

      const latest = delegationStore.getRun(parentSessionId, runId) ?? existing;
      return {
        ok: false,
        error: `cancel_timeout:${runId}`,
        run: {
          ...cloneDelegationRunRecord(latest),
          live: true,
          cancelable: true,
        },
      };
    },
    async cancelSessionRuns(parentSessionId, reason = "parent_session_cleared") {
      const liveStates = listDetachedSubagentLiveStates(options.runtime.workspaceRoot).filter(
        (entry) => entry.parentSessionId === parentSessionId,
      );
      for (const liveState of liveStates) {
        trackedPredicates.delete(liveState.runId);
        writeDetachedSubagentCancelRequest(options.runtime.workspaceRoot, liveState.runId, {
          schema: "brewva.subagent-cancel-request.v1",
          runId: liveState.runId,
          requestedAt: Date.now(),
          reason,
        });
        try {
          sendSignal(liveState.pid, "SIGTERM");
        } catch {
          // best effort; later status reconciliation will finalize state.
        }
      }
    },
  };
  options.runtime.events.subscribe((event) => {
    for (const [runId, tracked] of trackedPredicates.entries()) {
      if (tracked.parentSessionId !== event.sessionId) {
        continue;
      }
      const matched =
        tracked.predicate.source === "events"
          ? matchesEventPredicate(event, tracked.parentSessionId, tracked.predicate)
          : matchesWorkerResultPredicate(
              options.runtime,
              tracked.parentSessionId,
              tracked.predicate,
            );
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
