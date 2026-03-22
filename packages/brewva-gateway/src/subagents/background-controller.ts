import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
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
  readDetachedSubagentCancelRequest,
  removeDetachedSubagentCancelRequest,
  removeDetachedSubagentLiveState,
  resolveDetachedSubagentSpecPath,
  writeDetachedSubagentCancelRequest,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentSpec,
} from "./background-protocol.js";
import type { HostedSubagentProfile } from "./profiles.js";
import { resolveRequestedBoundary } from "./shared.js";

export interface HostedSubagentBackgroundController {
  startRun(input: {
    parentSessionId: string;
    profile: HostedSubagentProfile;
    packet: DelegationPacket;
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
  configPath?: string;
  routingScopes?: SkillRoutingScope[];
  spawnProcess?: (input: {
    modulePath: string;
    specPath: string;
    workspaceRoot: string;
  }) => ChildProcess;
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

function cloneRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
    artifactRefs: record.artifactRefs?.map((ref) => ({ ...ref })),
    delivery: record.delivery
      ? {
          ...record.delivery,
        }
      : undefined,
  };
}

function buildDeliveryRecord(
  delivery: SubagentRunRequest["delivery"] | undefined,
  updatedAt: number,
): DelegationRunRecord["delivery"] {
  if (!delivery) {
    return undefined;
  }
  return {
    mode: delivery.returnMode,
    scopeId: delivery.returnScopeId,
    label: delivery.returnLabel,
    updatedAt,
  };
}

function buildLifecyclePayload(record: DelegationRunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    profile: record.profile,
    label: record.label ?? null,
    kind: record.kind ?? null,
    boundary: record.boundary ?? null,
    parentSkill: record.parentSkill ?? null,
    childSessionId: record.workerSessionId ?? null,
    status: record.status,
    summary: record.summary ?? null,
    error: record.error ?? null,
    artifactRefs: record.artifactRefs ?? [],
    totalTokens: record.totalTokens ?? null,
    costUsd: record.costUsd ?? null,
    deliveryMode: record.delivery?.mode ?? null,
    deliveryScopeId: record.delivery?.scopeId ?? null,
    deliveryLabel: record.delivery?.label ?? null,
    supplementalAppended: record.delivery?.supplementalAppended ?? null,
    deliveryUpdatedAt: record.delivery?.updatedAt ?? null,
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

export function createDetachedSubagentBackgroundController(
  options: DetachedBackgroundControllerOptions,
): HostedSubagentBackgroundController {
  const modulePath = fileURLToPath(new URL("./runner-main.js", import.meta.url));
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const sendSignal =
    options.sendSignal ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });

  const writeTerminalFailure = (
    record: DelegationRunRecord,
    terminalStatus: Extract<DelegationRunRecord["status"], "failed" | "cancelled">,
    reason: string,
  ): DelegationRunRecord => {
    const updatedAt = Date.now();
    const updated: DelegationRunRecord = {
      ...cloneRecord(record),
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
    options.runtime.session.recordDelegationRun(record.parentSessionId, updated);
    options.runtime.events.record({
      sessionId: record.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildLifecyclePayload(updated),
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

  return {
    async startRun(input) {
      const runId = randomUUID();
      const createdAt = Date.now();
      const parentSkill = options.runtime.skills.getActive(input.parentSessionId)?.name;
      const boundary = resolveRequestedBoundary(input.profile, input.packet);
      const initialRecord: DelegationRunRecord = {
        runId,
        profile: input.profile.name,
        parentSessionId: input.parentSessionId,
        status: "pending",
        createdAt,
        updatedAt: createdAt,
        label: input.label,
        parentSkill,
        kind: input.profile.resultMode,
        boundary,
        delivery: buildDeliveryRecord(input.delivery, createdAt),
      };
      options.runtime.session.recordDelegationRun(input.parentSessionId, initialRecord);
      options.runtime.events.record({
        sessionId: input.parentSessionId,
        type: "subagent_spawned",
        payload: buildLifecyclePayload(initialRecord),
      });

      const spec: DetachedSubagentRunSpec = {
        schema: "brewva.subagent-run-spec.v2",
        runId,
        parentSessionId: input.parentSessionId,
        workspaceRoot: options.runtime.workspaceRoot,
        config: cloneRuntimeConfig(options.runtime),
        configPath: options.configPath,
        routingScopes: options.routingScopes,
        profileName: input.profile.name,
        label: input.label,
        packet: input.packet,
        timeoutMs: input.timeoutMs,
        delivery: input.delivery,
        createdAt,
      };
      writeDetachedSubagentSpec(options.runtime.workspaceRoot, runId, spec);

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
        profile: input.profile.name,
        pid,
        createdAt,
        updatedAt: createdAt,
        status: "pending",
        label: input.label,
      });
      return cloneRecord(initialRecord);
    },
    async inspectLiveRuns({ parentSessionId, query }) {
      const runs = options.runtime.session.listDelegationRuns(parentSessionId, query);
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
      const existing = options.runtime.session.getDelegationRun(parentSessionId, runId);
      if (!existing) {
        return {
          ok: false,
          error: `unknown_run:${runId}`,
        };
      }
      if (isTerminalStatus(existing.status)) {
        return {
          ok: false,
          error: `already_terminal:${existing.status}`,
          run: {
            ...cloneRecord(existing),
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
            ...cloneRecord(reconciled.record),
            live: false,
            cancelable: false,
          },
        };
      }

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
        const latest = options.runtime.session.getDelegationRun(parentSessionId, runId) ?? existing;
        const reconciled = await reconcileLiveState(latest);
        if (isTerminalStatus(reconciled.record.status)) {
          return {
            ok: reconciled.record.status === "cancelled" || reconciled.record.status === "timeout",
            error:
              reconciled.record.status === "cancelled" || reconciled.record.status === "timeout"
                ? undefined
                : `cancel_not_observed:${reconciled.record.status}`,
            run: {
              ...cloneRecord(reconciled.record),
              live: false,
              cancelable: false,
            },
          };
        }
      }

      const latest = options.runtime.session.getDelegationRun(parentSessionId, runId) ?? existing;
      return {
        ok: false,
        error: `cancel_timeout:${runId}`,
        run: {
          ...cloneRecord(latest),
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
}
