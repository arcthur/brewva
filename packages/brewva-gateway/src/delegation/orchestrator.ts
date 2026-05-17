import { randomUUID } from "node:crypto";
import type { BrewvaConfig, BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-runtime/delegation";
import { SUBAGENT_RUNNING_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type { PatchSet } from "@brewva/brewva-runtime/patch-history";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import type {
  BrewvaToolOrchestration,
  DelegationPacket,
  SubagentCancelResult,
  SubagentOutcome,
  SubagentOutcomeSuccess,
  SubagentForkRequest,
  SubagentForkResult,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
  SubagentStatusResult,
} from "@brewva/brewva-tools/contracts";
import {
  recordSessionTurnTransition,
  resolveSubagentSessionShutdownReason,
  runHostedTurnEnvelope,
  type SubscribablePromptSession,
} from "../hosted/api.js";
import { recordSessionShutdownIfMissing } from "../utils/runtime.js";
import type { HostedSubagentBackgroundController } from "./background/controller.js";
import {
  buildDelegationContextBundle,
  buildForkContextBundle,
} from "./build-delegation-context-bundle.js";
import { loadHostedDelegationCatalog } from "./catalog/registry.js";
import { writeDelegationContextBundleManifest } from "./context-manifest.js";
import {
  buildCompletedDelegationAdoption,
  buildDelegationRunRecordSeed,
  buildDelegationTaskIdentity,
  buildForkDelegationContractRecordFields,
} from "./delegation-records.js";
import {
  HostedDelegationStore,
  buildDelegationLifecyclePayload,
  cloneDelegationRunRecord,
} from "./delegation-store.js";
import { prepareSubagentEntry } from "./entry.js";
import { resolveDelegationExecutionPlan } from "./execution-plan.js";
import { buildInheritedSubagentContextBlock } from "./fork-context.js";
import {
  adoptDelegationLineageOutcome,
  ensureDelegationLineageNode,
  recordDelegationLineageOutcome,
} from "./lineage.js";
import type { DelegationModelRoutingContext } from "./model-routing.js";
import {
  buildDeliveryRecordFromRequest,
  createLaunchRunFailure,
  createLaunchStartFailure,
  deliverDelegationOutcome,
  mergeDeliveryRecord,
  mergeTaskPacket,
  preparePendingParentTurnDelivery,
  resolveDelegationLabel,
  resolveRunRecords,
} from "./orchestrator/records.js";
import { getCanonicalForkPrompt } from "./protocol.js";
import {
  applyDelegationFinalizationReceipt,
  aggregateChildCost,
  buildDelegationCompletionSummary,
  buildDelegationFailureOutcome,
  buildDelegationFailureFinalizationReceipt,
  buildDelegationFinalizationReceipt,
  rebuildDelegationFinalizationLifecycleEvent,
  type DelegationFinalizationReceipt,
  resolveRunSummary,
} from "./run-finalization.js";
import { buildDelegationRunPlan } from "./run-plan.js";
import { buildForkSubagentAgentId, buildSubagentAgentId } from "./shared.js";
import { resolveDelegationTarget } from "./target-resolution.js";
import {
  mergeDelegationPacketWithTargetDefaults,
  type HostedDelegationBuiltinToolName,
  type HostedDelegationTarget,
} from "./targets.js";
import {
  capturePatchSetFromIsolatedWorkspace,
  collectChangedPathsFromIsolatedWorkspace,
  copyDelegationContextManifestToIsolatedWorkspace,
  createIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";

export interface HostedSubagentSessionOptions {
  agentId: string;
  model?: string;
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  builtinToolNames?: readonly HostedDelegationBuiltinToolName[];
  managedToolNames?: readonly string[];
  managedToolMode?: ManagedToolMode;
  enableSubagents?: boolean;
}

export interface HostedSubagentSessionResult {
  runtime: BrewvaHostedRuntimePort;
  session: SubscribablePromptSession & {
    dispose(): void;
    abort?(): Promise<void>;
    sessionManager: {
      getSessionId(): string;
    };
  };
}

export interface HostedSubagentAdapterOptions {
  runtime: BrewvaHostedRuntimePort;
  createChildSession(input: HostedSubagentSessionOptions): Promise<HostedSubagentSessionResult>;
  backgroundController?: HostedSubagentBackgroundController;
  delegationStore?: HostedDelegationStore;
  modelRouting?: DelegationModelRoutingContext;
}

async function disposeChildSession(
  child: HostedSubagentSessionResult,
  input: {
    cancellationReason?: string;
    timeoutTriggered?: boolean;
    completionReason: string;
    source: string;
  },
): Promise<void> {
  try {
    recordSessionShutdownIfMissing(child.runtime, {
      sessionId: child.session.sessionManager.getSessionId(),
      reason: resolveSubagentSessionShutdownReason({
        timeoutTriggered: input.timeoutTriggered,
        cancellationReason: input.cancellationReason,
        completionReason: input.completionReason,
      }),
      source: input.source,
    });
    child.session.dispose();
  } catch {
    // best effort cleanup
  }
}

async function captureIsolatedPatchSet(
  sourceRoot: string,
  isolatedWorkspace: IsolatedWorkspaceHandle | undefined,
  summary: string,
  childSessionId?: string,
): Promise<PatchSet | undefined> {
  if (!isolatedWorkspace) {
    return undefined;
  }
  const candidatePaths = childSessionId
    ? collectChangedPathsFromIsolatedWorkspace({
        isolatedRoot: isolatedWorkspace.root,
        childSessionId,
      })
    : undefined;
  return await capturePatchSetFromIsolatedWorkspace({
    sourceRoot,
    isolatedRoot: isolatedWorkspace.root,
    summary,
    candidatePaths,
  });
}

interface LiveHostedDelegationRun {
  record: DelegationRunRecord;
  outcomePromise: Promise<SubagentOutcome>;
  cancel(reason?: string): Promise<DelegationRunRecord>;
  getView(): DelegationRunRecord & {
    live: boolean;
    cancelable: boolean;
  };
}

interface LiveHostedDelegationRegistry {
  byRunId: Map<string, LiveHostedDelegationRun>;
}

function createLiveDelegationRegistry(): LiveHostedDelegationRegistry {
  return {
    byRunId: new Map<string, LiveHostedDelegationRun>(),
  };
}

export function createHostedSubagentAdapter(
  options: HostedSubagentAdapterOptions,
): NonNullable<BrewvaToolOrchestration["subagents"]> {
  const delegationStore = options.delegationStore ?? new HostedDelegationStore(options.runtime);
  const liveRunsByParentSession = new Map<string, LiveHostedDelegationRegistry>();

  function getLiveRegistry(sessionId: string): LiveHostedDelegationRegistry {
    const existing = liveRunsByParentSession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = createLiveDelegationRegistry();
    liveRunsByParentSession.set(sessionId, created);
    return created;
  }

  function registerLiveRun(sessionId: string, run: LiveHostedDelegationRun): void {
    const registry = getLiveRegistry(sessionId);
    const record = run.getView();
    registry.byRunId.set(record.runId, run);
  }

  function removeLiveRun(sessionId: string, runId: string): void {
    const registry = liveRunsByParentSession.get(sessionId);
    if (!registry) {
      return;
    }
    const run = registry.byRunId.get(runId);
    if (!run) {
      return;
    }
    const record = run.getView();
    registry.byRunId.delete(record.runId);
    if (registry.byRunId.size === 0) {
      liveRunsByParentSession.delete(sessionId);
    }
  }

  function applyHostedFinalization(input: {
    parentSessionId: string;
    runId: string;
    delegate: string;
    delivery?: NonNullable<SubagentRunRequest["delivery"]>;
    initialDelivery?: DelegationRunRecord["delivery"];
    receipt: DelegationFinalizationReceipt;
    recordPendingTransition?: boolean;
  }): DelegationFinalizationReceipt {
    const deliveryResult = input.delivery
      ? input.delivery.returnMode === "supplemental"
        ? deliverDelegationOutcome({
            runtime: options.runtime,
            sessionId: input.parentSessionId,
            delegate: input.delegate,
            outcome: input.receipt.outcome,
            delivery: input.delivery,
          })
        : (() => {
            const result = preparePendingParentTurnDelivery();
            if (input.recordPendingTransition) {
              recordSessionTurnTransition(options.runtime, {
                sessionId: input.parentSessionId,
                reason: "subagent_delivery_pending",
                status: "entered",
                family: "delegation",
              });
            }
            return result;
          })()
      : undefined;
    const delivery = mergeDeliveryRecord(
      delegationStore.getRun(input.parentSessionId, input.runId)?.delivery ?? input.initialDelivery,
      deliveryResult,
    );
    const receipt = rebuildDelegationFinalizationLifecycleEvent({
      ...input.receipt,
      record: { ...input.receipt.record, delivery },
      lineageOutcome: { ...input.receipt.lineageOutcome, delivery },
      adoptLineageOutcome:
        input.receipt.adoptLineageOutcome || deliveryResult?.supplementalAppended === true,
    });
    applyDelegationFinalizationReceipt({
      runtime: options.runtime,
      receipt,
      recordLineageOutcome: (record) =>
        recordDelegationLineageOutcome({
          runtime: options.runtime,
          sessionId: input.parentSessionId,
          record,
        }),
      adoptLineageOutcome: (record) =>
        adoptDelegationLineageOutcome({
          runtime: options.runtime,
          sessionId: input.parentSessionId,
          record,
          admission: "context_eligible",
        }),
    });
    return receipt;
  }

  function collectReservedTaskPaths(parentSessionId: string): string[] {
    const persisted = delegationStore
      .listRuns(parentSessionId, { includeTerminal: true })
      .map((record) => record.taskPath);
    const live = liveRunsByParentSession.get(parentSessionId);
    if (!live) {
      return persisted;
    }
    return [...persisted, ...[...live.byRunId.values()].map((run) => run.getView().taskPath)];
  }

  function buildFanoutParentTaskPath(input: {
    parentSessionId: string;
    request: SubagentRunRequest;
    target: HostedDelegationTarget;
    invocationId: string;
  }): string | undefined {
    if (input.request.mode !== "parallel") {
      return undefined;
    }
    const invocationSegment = input.invocationId.replace(/-/g, "").slice(0, 8) || "fanout";
    const requestedLabel =
      input.request.taskName ??
      input.request.nickname ??
      input.request.packet?.objective ??
      input.target.targetName;
    const identity = buildDelegationTaskIdentity({
      target: input.target,
      label: `${requestedLabel}-${invocationSegment}`,
      reservedTaskPaths: collectReservedTaskPaths(input.parentSessionId),
    });
    return identity.taskPath;
  }

  async function resolveLaunchPlan(input: {
    fromSessionId: string;
    request: SubagentRunRequest;
  }): Promise<
    | {
        ok: true;
        target: HostedDelegationTarget;
        delegate: string;
        runs: Array<{
          label?: string;
          taskName?: string;
          nickname?: string;
          packet: DelegationPacket;
        }>;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    const catalog = await loadHostedDelegationCatalog(options.runtime.identity.workspaceRoot);
    let resolvedTarget;
    try {
      resolvedTarget = resolveDelegationTarget({
        request: {
          agent: input.request.agent,
          targetName: input.request.targetName,
          skillName: input.request.skillName,
          consultKind: input.request.consultKind,
          executionShape: input.request.executionShape,
          gateReason: input.request.gateReason,
        },
        catalog,
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const forkTurns = input.request.forkTurns ?? "none";
    if (resolvedTarget.target.agent === "worker" && forkTurns === "all") {
      return {
        ok: false,
        error: "worker_fork_turns_all_not_allowed",
      };
    }

    const sharedPacket = mergeDelegationPacketWithTargetDefaults(
      resolvedTarget.target,
      input.request.packet,
    );
    if (
      resolvedTarget.target.skillName &&
      !options.runtime.inspect.skills.catalog.get(resolvedTarget.target.skillName)
    ) {
      return {
        ok: false,
        error: `unknown_skill:${resolvedTarget.target.skillName}`,
      };
    }
    try {
      if (sharedPacket) {
        resolveDelegationExecutionPlan({
          runtime: options.runtime,
          target: resolvedTarget.target,
          delegate: resolvedTarget.delegate,
          packet: sharedPacket,
          executionShape: input.request.executionShape,
          modelRouting: options.modelRouting,
        });
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (input.request.mode === "single") {
      if (!sharedPacket) {
        return {
          ok: false,
          error: "missing_delegation_packet",
        };
      }
      return {
        ok: true,
        target: resolvedTarget.target,
        delegate: resolvedTarget.delegate,
        runs: [
          {
            packet: sharedPacket,
            taskName: input.request.taskName,
            nickname: input.request.nickname,
          },
        ],
      };
    }

    const tasks = input.request.tasks ?? [];
    if (tasks.length === 0) {
      return {
        ok: false,
        error: "missing_parallel_tasks",
      };
    }

    return {
      ok: true,
      target: resolvedTarget.target,
      delegate: resolvedTarget.delegate,
      runs: tasks.map((task) => ({
        label: task.label,
        taskName: task.taskName,
        nickname: task.nickname,
        packet: mergeTaskPacket(sharedPacket, task),
      })),
    };
  }

  function startDelegationRun(input: {
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
  }): LiveHostedDelegationRun {
    const runId = randomUUID();
    const startedAt = Date.now();
    const delegate = input.delegate ?? resolveDelegationLabel(input.target);
    const taskIdentity = buildDelegationTaskIdentity({
      target: input.target,
      requestedTaskName: input.taskName,
      requestedNickname: input.nickname,
      label: input.label,
      parentTaskPath: input.parentTaskPath,
      reservedTaskPaths: collectReservedTaskPaths(input.parentSessionId),
    });
    const forkTurns = input.forkTurns ?? "none";

    let child: HostedSubagentSessionResult | undefined;
    let isolatedWorkspace: IsolatedWorkspaceHandle | undefined;
    let childSessionId: import("@brewva/brewva-runtime/core").BrewvaSessionId | undefined;
    let executionPlan: ReturnType<typeof resolveDelegationExecutionPlan> | undefined;
    let runPlan: ReturnType<typeof buildDelegationRunPlan> | undefined;
    let parallelSlotReleased = false;
    let cancellationReason: string | undefined;
    let timeoutTriggered = false;
    let finished = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const immediateFailure = (error: string): LiveHostedDelegationRun => {
      const failedAt = Date.now();
      const failedRecord: DelegationRunRecord = {
        ...buildDelegationRunRecordSeed({
          runId,
          target: input.target,
          parentSessionId: asBrewvaSessionId(input.parentSessionId),
          createdAt: startedAt,
          updatedAt: failedAt,
          status: "failed",
          label: input.label,
          taskIdentity,
          forkTurns,
          delivery: buildDeliveryRecordFromRequest(input.delivery, failedAt),
        }),
        status: "failed",
        summary: error,
        error,
      };
      options.runtime.extensions.hosted.events.record({
        sessionId: input.parentSessionId,
        type: "subagent_failed",
        payload: buildDelegationLifecyclePayload(failedRecord),
      });
      recordDelegationLineageOutcome({
        runtime: options.runtime,
        sessionId: input.parentSessionId,
        record: failedRecord,
      });
      return {
        record: failedRecord,
        outcomePromise: Promise.resolve(
          buildDelegationFailureOutcome({
            target: input.target,
            taskIdentity,
            runId,
            delegate,
            label: input.label,
            message: error,
            status: "error",
            startedAt,
            finishedAt: failedAt,
          }),
        ),
        async cancel() {
          return cloneDelegationRunRecord(failedRecord);
        },
        getView() {
          return {
            ...cloneDelegationRunRecord(failedRecord),
            live: false,
            cancelable: false,
          };
        },
      };
    };

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
      return immediateFailure(error instanceof Error ? error.message : String(error));
    }

    const parallel = options.runtime.authority.tools.parallel.acquire(input.parentSessionId, runId);
    if (!parallel.accepted) {
      return immediateFailure(`parallel_slot_rejected:${parallel.reason ?? "unknown"}`);
    }

    const initialRecord: DelegationRunRecord = {
      ...buildDelegationRunRecordSeed({
        runId,
        target: input.target,
        parentSessionId: asBrewvaSessionId(input.parentSessionId),
        createdAt: startedAt,
        label: input.label,
        taskIdentity,
        forkTurns,
        boundary: executionPlan.boundary,
        modelRoute: executionPlan.modelRoute,
        delivery: buildDeliveryRecordFromRequest(input.delivery, startedAt),
      }),
    };

    options.runtime.extensions.hosted.events.record({
      sessionId: input.parentSessionId,
      type: "subagent_spawned",
      payload: buildDelegationLifecyclePayload(initialRecord),
    });
    ensureDelegationLineageNode({
      runtime: options.runtime,
      sessionId: input.parentSessionId,
      record: initialRecord,
    });

    const liveRun: LiveHostedDelegationRun = {
      record: initialRecord,
      async cancel(reason) {
        const latest = delegationStore.getRun(input.parentSessionId, runId);
        if (!latest) {
          return cloneDelegationRunRecord(initialRecord);
        }
        if (isDelegationRunTerminalStatus(latest.status)) {
          return cloneDelegationRunRecord(latest);
        }
        cancellationReason = reason?.trim() || "cancelled_by_parent";
        if (child?.session.abort) {
          await child.session.abort().catch(() => undefined);
        } else if (child?.session) {
          await disposeChildSession(child, {
            cancellationReason,
            completionReason: "subagent_run_complete",
            source: "subagent_orchestrator",
          });
        }
        await liveRun.outcomePromise.catch(() => undefined);
        return (
          delegationStore.getRun(input.parentSessionId, runId) ?? cloneDelegationRunRecord(latest)
        );
      },
      getView() {
        const latest = delegationStore.getRun(input.parentSessionId, runId) ?? liveRun.record;
        const terminal = isDelegationRunTerminalStatus(latest.status);
        return {
          ...cloneDelegationRunRecord(latest),
          live: !terminal && !finished,
          cancelable: !terminal && !finished,
        };
      },
      outcomePromise: Promise.resolve(
        buildDelegationFailureOutcome({
          target: input.target,
          taskIdentity,
          runId,
          delegate,
          label: input.label,
          message: "uninitialized",
          status: "error",
          startedAt,
          finishedAt: startedAt,
        }),
      ),
    };

    const runPromise = (async (): Promise<SubagentOutcome> => {
      try {
        if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timeoutTriggered = true;
            cancellationReason = `timeout:${input.timeoutMs}`;
            void child?.session.abort?.();
          }, input.timeoutMs);
        }

        const inheritedBlock = buildInheritedSubagentContextBlock({
          runtime: options.runtime,
          sessionId: input.parentSessionId,
          forkTurns,
        });
        const contextBundleResult = buildDelegationContextBundle({
          packet: input.packet,
          inheritedBlock,
          createdAt: startedAt,
        });
        if (!contextBundleResult.ok) {
          throw new Error(
            `delegation_context_blocked:${contextBundleResult.blocker.overflow}:${contextBundleResult.blocker.requiredTokens}/${contextBundleResult.blocker.maxTokens}`,
          );
        }
        const contextBundle = contextBundleResult.bundle;
        runPlan = buildDelegationRunPlan({
          runId,
          parentSessionId: input.parentSessionId,
          delegate,
          packet: input.packet,
          target: input.target,
          executionPlan,
          taskIdentity,
          modelRoute: executionPlan.modelRoute,
          contextBundle,
          delivery: input.delivery,
          createdAt: startedAt,
        });
        const plan = runPlan;
        writeDelegationContextBundleManifest(options.runtime.identity.workspaceRoot, runId, {
          schema: "brewva.delegation-context-bundle.v1",
          runId,
          generatedAt: Date.now(),
          bundle: contextBundle,
          hash: contextBundle.hash,
        });
        if (executionPlan.boundary === "effectful") {
          isolatedWorkspace = await createIsolatedWorkspace(options.runtime.identity.workspaceRoot);
          await copyDelegationContextManifestToIsolatedWorkspace({
            sourceRoot: options.runtime.identity.workspaceRoot,
            isolatedRoot: isolatedWorkspace.root,
            runId,
          });
        }

        child = await options.createChildSession({
          agentId: buildSubagentAgentId(delegate),
          model: executionPlan.model,
          cwd: isolatedWorkspace?.root,
          config: structuredClone(options.runtime.config) as BrewvaConfig,
          builtinToolNames: executionPlan.builtinToolNames,
          managedToolNames: executionPlan.managedToolNames,
          managedToolMode: executionPlan.managedToolMode,
          enableSubagents: false,
        });

        childSessionId = asBrewvaSessionId(child.session.sessionManager.getSessionId());
        if (timeoutTriggered && child.session.abort) {
          await child.session.abort().catch(() => undefined);
        }
        const runningRecord: DelegationRunRecord = {
          ...(delegationStore.getRun(input.parentSessionId, runId) ?? initialRecord),
          status: "running",
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
          modelRoute: executionPlan.modelRoute,
        };
        liveRun.record = cloneDelegationRunRecord(runningRecord);
        options.runtime.extensions.hosted.events.record({
          sessionId: input.parentSessionId,
          type: SUBAGENT_RUNNING_EVENT_TYPE,
          payload: buildDelegationLifecyclePayload(runningRecord),
        });

        const preparedEntry = prepareSubagentEntry({
          parentRuntime: options.runtime,
          childRuntime: child.runtime,
          childSessionId,
          target: plan.target,
          packet: plan.packet,
          promptOverride: executionPlan.prompt,
          contextBundle: plan.contextBundle,
        });
        const { delegatedSkill, childOwnsSkill, prompt } = preparedEntry;
        const output = await runHostedTurnEnvelope({
          session: child.session,
          prompt,
          runtime: child.runtime,
          sessionId: childSessionId,
          source: "subagent",
        });
        if (output.status !== "completed") {
          throw new Error(`subagent_thread_loop_${output.status}`);
        }
        const childCostSummary = child.runtime.inspect.cost.summary.get(childSessionId);
        const completionSummary = buildDelegationCompletionSummary({
          target: input.target,
          delegatedSkillName: delegatedSkill,
          childOwnsSkill,
          assistantText: output.assistantText,
        });
        const patches = executionPlan.producesPatches
          ? await captureIsolatedPatchSet(
              options.runtime.identity.workspaceRoot,
              isolatedWorkspace,
              completionSummary.summary,
              childSessionId,
            )
          : undefined;
        const finishedAt = Date.now();
        let finalizationReceipt = buildDelegationFinalizationReceipt({
          parentSessionId: plan.parentSessionId,
          initialRecord,
          currentRecord: delegationStore.getRun(plan.parentSessionId, plan.runId),
          target: plan.target,
          executionPlan: plan.executionPlan,
          taskIdentity: plan.taskIdentity,
          runId: plan.runId,
          delegate: plan.delegate,
          delegatedSkillName: delegatedSkill,
          childOwnsSkill,
          childSessionId,
          label: input.label,
          startedAt,
          finishedAt,
          assistantText: output.assistantText,
          toolOutputs: output.toolOutputs,
          childCostSummary,
          patches,
        });

        finalizationReceipt = applyHostedFinalization({
          parentSessionId: input.parentSessionId,
          runId,
          delegate,
          delivery: input.delivery,
          initialDelivery: initialRecord.delivery,
          receipt: finalizationReceipt,
          recordPendingTransition: true,
        });
        if (finalizationReceipt.workerResult) {
          parallelSlotReleased = true;
        }
        liveRun.record = finalizationReceipt.record;
        return finalizationReceipt.outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminalStatus: Extract<
          DelegationRunRecord["status"],
          "failed" | "cancelled" | "timeout"
        > = timeoutTriggered ? "timeout" : cancellationReason ? "cancelled" : "failed";
        const terminalCostSummary =
          child && childSessionId
            ? child.runtime.inspect.cost.summary.get(childSessionId)
            : undefined;
        const patches = executionPlan.producesPatches
          ? await captureIsolatedPatchSet(
              options.runtime.identity.workspaceRoot,
              isolatedWorkspace,
              message,
              childSessionId,
            ).catch(() => undefined)
          : undefined;
        const finishedAt = Date.now();
        const failedPlan = runPlan;
        let finalizationReceipt = buildDelegationFailureFinalizationReceipt({
          parentSessionId: failedPlan?.parentSessionId ?? input.parentSessionId,
          initialRecord,
          currentRecord: delegationStore.getRun(
            failedPlan?.parentSessionId ?? input.parentSessionId,
            failedPlan?.runId ?? runId,
          ),
          target: failedPlan?.target ?? input.target,
          executionPlan: failedPlan?.executionPlan ?? executionPlan,
          taskIdentity: failedPlan?.taskIdentity ?? taskIdentity,
          runId: failedPlan?.runId ?? runId,
          delegate: failedPlan?.delegate ?? delegate,
          childSessionId,
          label: input.label,
          startedAt,
          finishedAt,
          message,
          terminalStatus,
          patches,
          terminalCostSummary,
          cancellationReason,
        });
        finalizationReceipt = applyHostedFinalization({
          parentSessionId: input.parentSessionId,
          runId,
          delegate,
          delivery: input.delivery,
          initialDelivery: initialRecord.delivery,
          receipt: finalizationReceipt,
        });
        if (finalizationReceipt.workerResult) {
          parallelSlotReleased = true;
        }
        liveRun.record = finalizationReceipt.record;
        return finalizationReceipt.outcome;
      } finally {
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (!parallelSlotReleased) {
          options.runtime.authority.tools.parallel.release(input.parentSessionId, runId);
        }
        if (child) {
          await disposeChildSession(child, {
            cancellationReason,
            timeoutTriggered,
            completionReason: "subagent_run_complete",
            source: "subagent_orchestrator",
          });
        }
        if (isolatedWorkspace) {
          await isolatedWorkspace.dispose();
        }
        removeLiveRun(input.parentSessionId, runId);
      }
    })();

    liveRun.outcomePromise = runPromise;
    registerLiveRun(input.parentSessionId, liveRun);
    return liveRun;
  }

  async function runFork(input: {
    fromSessionId: string;
    request: SubagentForkRequest;
  }): Promise<SubagentForkResult> {
    const runId = randomUUID();
    const startedAt = Date.now();
    const parentSessionId = asBrewvaSessionId(input.fromSessionId);
    const forkTurns = input.request.forkTurns ?? "all";
    const taskIdentity = buildDelegationTaskIdentity({
      target: { agent: "explorer" },
      requestedTaskName: input.request.taskName,
      requestedNickname: input.request.nickname,
      label: "fork",
      reservedTaskPaths: collectReservedTaskPaths(input.fromSessionId),
    });
    const catalog = await loadHostedDelegationCatalog(options.runtime.identity.workspaceRoot);
    const readonlyEnvelope = catalog.envelopes.get("explorer-readonly");
    if (!readonlyEnvelope) {
      throw new Error("missing_explorer_readonly_envelope");
    }
    const contractFields = buildForkDelegationContractRecordFields({
      parentSessionId,
      forkTurns,
      isolationStrategy: readonlyEnvelope.isolationStrategy,
    });
    const initialRecord: DelegationRunRecord = {
      runId,
      agent: "explorer",
      targetName: "fork",
      delegate: "fork",
      taskName: taskIdentity.taskName,
      taskPath: taskIdentity.taskPath,
      nickname: taskIdentity.nickname,
      depth: taskIdentity.depth,
      forkTurns,
      gateReason: "make_judgment",
      modelCategory: "deep-reasoning",
      ...contractFields,
      parentSessionId,
      status: "pending",
      createdAt: startedAt,
      updatedAt: startedAt,
      kind: "consult",
      consultKind: "investigate",
      boundary: "safe",
      summary: input.request.objective,
      delivery: buildDeliveryRecordFromRequest(input.request.delivery, startedAt),
    };

    options.runtime.extensions.hosted.events.record({
      sessionId: input.fromSessionId,
      type: "subagent_spawned",
      payload: buildDelegationLifecyclePayload(initialRecord),
    });
    ensureDelegationLineageNode({
      runtime: options.runtime,
      sessionId: input.fromSessionId,
      record: initialRecord,
    });

    const parallel = options.runtime.authority.tools.parallel.acquire(input.fromSessionId, runId);
    if (!parallel.accepted) {
      const failedRecord: DelegationRunRecord = {
        ...initialRecord,
        status: "failed",
        updatedAt: Date.now(),
        summary: `parallel_slot_rejected:${parallel.reason ?? "unknown"}`,
        error: `parallel_slot_rejected:${parallel.reason ?? "unknown"}`,
      };
      options.runtime.extensions.hosted.events.record({
        sessionId: input.fromSessionId,
        type: "subagent_failed",
        payload: buildDelegationLifecyclePayload(failedRecord),
      });
      recordDelegationLineageOutcome({
        runtime: options.runtime,
        sessionId: input.fromSessionId,
        record: failedRecord,
      });
      return {
        ok: false,
        error: failedRecord.error ?? "parallel_slot_rejected",
        run: cloneDelegationRunRecord(failedRecord),
      };
    }

    let child: HostedSubagentSessionResult | undefined;
    let childSessionId: import("@brewva/brewva-runtime/core").BrewvaSessionId | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutTriggered = false;

    try {
      if (typeof input.request.timeoutMs === "number" && input.request.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timeoutTriggered = true;
          void child?.session.abort?.();
        }, input.request.timeoutMs);
      }

      child = await options.createChildSession({
        agentId: buildForkSubagentAgentId(input.fromSessionId),
        config: structuredClone(options.runtime.config) as BrewvaConfig,
        builtinToolNames: readonlyEnvelope.builtinToolNames,
        managedToolNames: readonlyEnvelope.managedToolNames,
        managedToolMode: readonlyEnvelope.managedToolMode,
        enableSubagents: false,
      });
      childSessionId = asBrewvaSessionId(child.session.sessionManager.getSessionId());

      const runningRecord: DelegationRunRecord = {
        ...(delegationStore.getRun(input.fromSessionId, runId) ?? initialRecord),
        status: "running",
        updatedAt: Date.now(),
        workerSessionId: childSessionId,
      };
      options.runtime.extensions.hosted.events.record({
        sessionId: input.fromSessionId,
        type: SUBAGENT_RUNNING_EVENT_TYPE,
        payload: buildDelegationLifecyclePayload(runningRecord),
      });

      const contextBundle = buildForkContextBundle({
        inheritedBlock: buildInheritedSubagentContextBlock({
          runtime: options.runtime,
          sessionId: input.fromSessionId,
          forkTurns,
        }),
      });
      if (!contextBundle.ok) {
        throw new Error(
          `fork_context_blocked:${contextBundle.blocker.overflow}:${contextBundle.blocker.requiredTokens}/${contextBundle.blocker.maxTokens}`,
        );
      }
      const prompt = getCanonicalForkPrompt({
        forkTurns,
        objective: input.request.objective,
        deliverable: input.request.deliverable,
        contextBundle: contextBundle.bundle,
      });
      const output = await runHostedTurnEnvelope({
        session: child.session,
        prompt,
        runtime: child.runtime,
        sessionId: childSessionId,
        source: "subagent",
      });
      if (output.status !== "completed") {
        throw new Error(`subagent_fork_thread_loop_${output.status}`);
      }

      const childCostSummary = child.runtime.inspect.cost.summary.get(childSessionId);
      aggregateChildCost(options.runtime, input.fromSessionId, childCostSummary);
      const summary = resolveRunSummary(output.assistantText, "Fork completed.");
      const completedRecord: DelegationRunRecord = {
        ...(delegationStore.getRun(input.fromSessionId, runId) ?? runningRecord),
        status: "completed",
        updatedAt: Date.now(),
        workerSessionId: childSessionId,
        adoption: buildCompletedDelegationAdoption({
          target: {
            resultMode: "consult",
          },
          executionPrimitive: "fork",
          resultData: undefined,
        }),
        summary,
        resultData: {
          kind: "consult",
          consultKind: "investigate",
          conclusion: summary,
        },
        totalTokens: childCostSummary.totalTokens,
        costUsd: childCostSummary.totalCostUsd,
      };
      options.runtime.extensions.hosted.events.record({
        sessionId: input.fromSessionId,
        type: "subagent_completed",
        payload: buildDelegationLifecyclePayload(completedRecord),
      });
      recordDelegationLineageOutcome({
        runtime: options.runtime,
        sessionId: input.fromSessionId,
        record: completedRecord,
      });
      return {
        ok: true,
        run: cloneDelegationRunRecord(completedRecord),
      };
    } catch (error) {
      const message = timeoutTriggered
        ? `timeout:${input.request.timeoutMs}`
        : error instanceof Error
          ? error.message
          : String(error);
      const failedRecord: DelegationRunRecord = {
        ...(delegationStore.getRun(input.fromSessionId, runId) ?? initialRecord),
        status: timeoutTriggered ? "timeout" : "failed",
        updatedAt: Date.now(),
        workerSessionId: childSessionId,
        summary: message,
        error: message,
      };
      options.runtime.extensions.hosted.events.record({
        sessionId: input.fromSessionId,
        type: "subagent_failed",
        payload: buildDelegationLifecyclePayload(failedRecord),
      });
      recordDelegationLineageOutcome({
        runtime: options.runtime,
        sessionId: input.fromSessionId,
        record: failedRecord,
      });
      return {
        ok: false,
        error: message,
        run: cloneDelegationRunRecord(failedRecord),
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      options.runtime.authority.tools.parallel.release(input.fromSessionId, runId);
      if (child) {
        await disposeChildSession(child, {
          cancellationReason: timeoutTriggered ? `timeout:${input.request.timeoutMs}` : undefined,
          timeoutTriggered,
          completionReason: "subagent_fork_complete",
          source: "subagent_orchestrator",
        });
      }
    }
  }

  options.runtime.operator.session.state.onClear((sessionId) => {
    delegationStore.clearSession(sessionId);
    if (options.backgroundController?.cancelSessionRuns) {
      void options.backgroundController.cancelSessionRuns(sessionId, "parent_session_cleared");
    }
    const liveRegistry = liveRunsByParentSession.get(sessionId);
    if (!liveRegistry) {
      return;
    }
    for (const run of liveRegistry.byRunId.values()) {
      void run.cancel("parent_session_cleared");
    }
    liveRunsByParentSession.delete(sessionId);
  });

  return {
    run: async ({ fromSessionId, request }): Promise<SubagentRunResult> => {
      const launchPlan = await resolveLaunchPlan({ fromSessionId, request });
      if (!launchPlan.ok) {
        return createLaunchRunFailure({
          mode: request.mode,
          delegate: request.targetName ?? request.skillName ?? request.agent ?? "derived",
          error: launchPlan.error,
        });
      }

      const parentTaskPath = buildFanoutParentTaskPath({
        parentSessionId: fromSessionId,
        request,
        target: launchPlan.target,
        invocationId: randomUUID(),
      });
      const liveRuns = launchPlan.runs.map((run) =>
        startDelegationRun({
          parentSessionId: fromSessionId,
          target: launchPlan.target,
          delegate: launchPlan.delegate,
          packet: run.packet,
          executionShape: request.executionShape,
          label: run.label,
          taskName: run.taskName,
          nickname: run.nickname,
          parentTaskPath,
          forkTurns: request.forkTurns,
          timeoutMs: request.timeoutMs,
        }),
      );
      const outcomes = await Promise.all(liveRuns.map((run) => run.outcomePromise));
      const failures = outcomes.filter((outcome) => !outcome.ok);
      if (failures.length > 0) {
        return {
          ok: false,
          mode: request.mode,
          delegate: launchPlan.delegate,
          outcomes,
          error: failures[0]?.error ?? "subagent_run_failed",
        };
      }
      return {
        ok: true,
        mode: request.mode,
        delegate: launchPlan.delegate,
        outcomes: outcomes.filter((outcome): outcome is SubagentOutcomeSuccess => outcome.ok),
      };
    },
    start: async ({ fromSessionId, request }): Promise<SubagentStartResult> => {
      const launchPlan = await resolveLaunchPlan({ fromSessionId, request });
      if (!launchPlan.ok) {
        return createLaunchStartFailure({
          mode: request.mode,
          delegate: request.targetName ?? request.skillName ?? request.agent ?? "derived",
          error: launchPlan.error,
        });
      }

      const parentTaskPath = buildFanoutParentTaskPath({
        parentSessionId: fromSessionId,
        request,
        target: launchPlan.target,
        invocationId: randomUUID(),
      });
      if (options.backgroundController) {
        const runs = await Promise.all(
          launchPlan.runs.map((run) =>
            options.backgroundController!.startRun({
              parentSessionId: fromSessionId,
              target: launchPlan.target,
              delegate: launchPlan.delegate,
              packet: run.packet,
              executionShape: request.executionShape,
              label: run.label,
              taskName: run.taskName,
              nickname: run.nickname,
              parentTaskPath,
              forkTurns: request.forkTurns,
              timeoutMs: request.timeoutMs,
              delivery: request.delivery,
            }),
          ),
        );
        const failedRun = runs.find((run) => run.status === "failed");
        if (failedRun) {
          return {
            ok: false,
            mode: request.mode,
            delegate: launchPlan.delegate,
            runs: runs.map((run) => cloneDelegationRunRecord(run)),
            error: failedRun.error ?? `subagent_start_failed:${failedRun.runId}`,
          };
        }
        return {
          ok: true,
          mode: request.mode,
          delegate: launchPlan.delegate,
          runs: runs.map((run) => cloneDelegationRunRecord(run)),
        };
      }

      const liveRuns = launchPlan.runs.map((run) =>
        startDelegationRun({
          parentSessionId: fromSessionId,
          target: launchPlan.target,
          delegate: launchPlan.delegate,
          packet: run.packet,
          executionShape: request.executionShape,
          label: run.label,
          taskName: run.taskName,
          nickname: run.nickname,
          parentTaskPath,
          forkTurns: request.forkTurns,
          timeoutMs: request.timeoutMs,
          delivery: request.delivery,
        }),
      );
      const failedLiveRun = liveRuns.find((run) => run.record.status === "failed");
      if (failedLiveRun) {
        return {
          ok: false,
          mode: request.mode,
          delegate: launchPlan.delegate,
          runs: liveRuns.map((run) => cloneDelegationRunRecord(run.record)),
          error:
            failedLiveRun.record.error ?? `subagent_start_failed:${failedLiveRun.record.runId}`,
        };
      }
      return {
        ok: true,
        mode: request.mode,
        delegate: launchPlan.delegate,
        runs: liveRuns.map((run) => cloneDelegationRunRecord(run.record)),
      };
    },
    status: async ({ fromSessionId, query }): Promise<SubagentStatusResult> => {
      const backgroundLiveStates = options.backgroundController
        ? await options.backgroundController.inspectLiveRuns({
            parentSessionId: fromSessionId,
            query,
          })
        : undefined;
      const persistedRuns = resolveRunRecords(delegationStore, fromSessionId, query);
      const liveRegistry = liveRunsByParentSession.get(fromSessionId);
      const runs = persistedRuns.map((record) => {
        const liveRun = liveRegistry?.byRunId.get(record.runId);
        const backgroundLive = backgroundLiveStates?.get(record.runId);
        return Object.assign(cloneDelegationRunRecord(record), {
          live:
            backgroundLive?.live ?? (!!liveRun && !isDelegationRunTerminalStatus(record.status)),
          cancelable:
            backgroundLive?.cancelable ??
            (!!liveRun && !isDelegationRunTerminalStatus(record.status)),
        });
      });
      return {
        ok: true,
        runs,
      };
    },
    cancel: async ({ fromSessionId, runId, reason }): Promise<SubagentCancelResult> => {
      if (options.backgroundController) {
        return options.backgroundController.cancelRun({
          parentSessionId: fromSessionId,
          runId,
          reason,
        });
      }
      const liveRun = liveRunsByParentSession.get(fromSessionId)?.byRunId.get(runId);
      if (!liveRun) {
        const persisted = delegationStore.getRun(fromSessionId, runId);
        if (!persisted) {
          return {
            ok: false,
            error: `unknown_run:${runId}`,
          };
        }
        if (isDelegationRunTerminalStatus(persisted.status)) {
          return {
            ok: false,
            error: `already_terminal:${persisted.status}`,
            run: {
              ...cloneDelegationRunRecord(persisted),
              live: false,
              cancelable: false,
            },
          };
        }
        return {
          ok: false,
          error: `not_live_in_this_process:${runId}`,
          run: {
            ...cloneDelegationRunRecord(persisted),
            live: false,
            cancelable: false,
          },
        };
      }

      const record = await liveRun.cancel(reason);
      const run = {
        ...cloneDelegationRunRecord(record),
        live: false,
        cancelable: false,
      };
      if (record.status === "cancelled" || record.status === "timeout") {
        return {
          ok: true,
          run,
        };
      }
      return {
        ok: false,
        error: `cancel_not_observed:${record.status}`,
        run,
      };
    },
    fork: async ({ fromSessionId, request }): Promise<SubagentForkResult> =>
      runFork({ fromSessionId, request }),
  };
}
