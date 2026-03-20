import { randomUUID } from "node:crypto";
import type {
  BrewvaRuntime,
  DelegationRunQuery,
  DelegationRunRecord,
  PatchSet,
  WorkerResult,
} from "@brewva/brewva-runtime";
import type {
  BrewvaToolOrchestration,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentCancelResult,
  SubagentOutcomeArtifactRef,
  SubagentExecutionBoundary,
  SubagentOutcome,
  SubagentOutcomeSuccess,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
  SubagentStatusResult,
} from "@brewva/brewva-tools";
import { collectSessionPromptOutput } from "../session/collect-output.js";
import type { HostedSubagentBackgroundController } from "./background-controller.js";
import {
  loadHostedSubagentProfiles,
  mergeDelegationPacketWithProfileDefaults,
  type HostedSubagentBuiltinToolName,
  type HostedSubagentProfile,
} from "./profiles.js";
import { buildDelegationPrompt } from "./prompt.js";
import {
  aggregateChildCost,
  buildPatchArtifactRefs,
  buildWorkerResult,
  resolveBuiltinToolNamesForRun,
  resolveManagedToolNamesForRun,
  resolveRequestedBoundary,
  resolveRunSummary,
  sanitizeFragment,
} from "./shared.js";
import {
  capturePatchSetFromIsolatedWorkspace,
  createIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";

export interface HostedSubagentSessionOptions {
  agentId: string;
  model?: string;
  cwd?: string;
  configPath?: string;
  builtinToolNames?: readonly HostedSubagentBuiltinToolName[];
  managedToolNames?: readonly string[];
  enableExtensions?: boolean;
  enableSubagents?: boolean;
  orchestration?: BrewvaToolOrchestration;
}

export interface HostedSubagentSessionResult {
  runtime: BrewvaRuntime;
  session: {
    dispose(): void;
    abort?(): Promise<void>;
    sendUserMessage(content: string, options?: { deliverAs?: "followUp" }): Promise<void>;
    agent: {
      waitForIdle(): Promise<void>;
    };
    sessionManager: {
      getSessionId(): string;
    };
    subscribe: Parameters<typeof collectSessionPromptOutput>[0]["subscribe"];
  };
}

export interface HostedSubagentAdapterOptions {
  runtime: BrewvaRuntime;
  createChildSession(input: HostedSubagentSessionOptions): Promise<HostedSubagentSessionResult>;
  backgroundController?: HostedSubagentBackgroundController;
}

function mergeTaskPacket(
  sharedPacket: DelegationPacket | undefined,
  taskPacket: DelegationTaskPacket,
): DelegationPacket {
  return {
    objective: taskPacket.objective,
    deliverable: taskPacket.deliverable ?? sharedPacket?.deliverable,
    constraints: [...(sharedPacket?.constraints ?? []), ...(taskPacket.constraints ?? [])],
    sharedNotes: [...(sharedPacket?.sharedNotes ?? []), ...(taskPacket.sharedNotes ?? [])],
    activeSkillName: taskPacket.activeSkillName ?? sharedPacket?.activeSkillName,
    entrySkill: taskPacket.entrySkill ?? sharedPacket?.entrySkill,
    requiredOutputs: [
      ...(sharedPacket?.requiredOutputs ?? []),
      ...(taskPacket.requiredOutputs ?? []),
    ],
    executionHints: {
      preferredTools: [
        ...(sharedPacket?.executionHints?.preferredTools ?? []),
        ...(taskPacket.executionHints?.preferredTools ?? []),
      ],
      fallbackTools: [
        ...(sharedPacket?.executionHints?.fallbackTools ?? []),
        ...(taskPacket.executionHints?.fallbackTools ?? []),
      ],
      preferredSkills: [
        ...(sharedPacket?.executionHints?.preferredSkills ?? []),
        ...(taskPacket.executionHints?.preferredSkills ?? []),
      ],
    },
    contextRefs: [...(sharedPacket?.contextRefs ?? []), ...(taskPacket.contextRefs ?? [])],
    contextBudget: {
      ...sharedPacket?.contextBudget,
      ...taskPacket.contextBudget,
    },
    effectCeiling: {
      boundary: taskPacket.effectCeiling?.boundary ?? sharedPacket?.effectCeiling?.boundary,
    },
  };
}

function buildFailureOutcome(input: {
  runId: string;
  profile: string;
  label?: string;
  workerSessionId?: string;
  artifactRefs?: SubagentOutcomeArtifactRef[];
  error: string;
  startedAt: number;
}): SubagentOutcome {
  return {
    ok: false,
    runId: input.runId,
    profile: input.profile,
    label: input.label,
    status: "error",
    workerSessionId: input.workerSessionId,
    error: input.error,
    metrics: {
      durationMs: Math.max(0, Date.now() - input.startedAt),
    },
    artifactRefs: input.artifactRefs,
  };
}

async function disposeChildSession(session: HostedSubagentSessionResult["session"]): Promise<void> {
  try {
    session.dispose();
  } catch {
    // best effort cleanup
  }
}

async function captureIsolatedPatchSet(
  sourceRoot: string,
  isolatedWorkspace: IsolatedWorkspaceHandle | undefined,
  summary: string,
): Promise<PatchSet | undefined> {
  if (!isolatedWorkspace) {
    return undefined;
  }
  return await capturePatchSetFromIsolatedWorkspace({
    sourceRoot,
    isolatedRoot: isolatedWorkspace.root,
    summary,
  });
}

function isTerminalRunStatus(status: DelegationRunRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled" ||
    status === "merged"
  );
}

function cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
    artifactRefs: record.artifactRefs?.map((ref) => ({ ...ref })),
    delivery: record.delivery
      ? {
          mode: record.delivery.mode,
          scopeId: record.delivery.scopeId,
          label: record.delivery.label,
          supplementalAppended: record.delivery.supplementalAppended,
          updatedAt: record.delivery.updatedAt,
        }
      : undefined,
  };
}

function summarizeOutcomeForDelivery(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: ${outcome.status} (${outcome.error})`;
  }
  const parts = [
    outcome.kind,
    outcome.workerSessionId ? `worker=${outcome.workerSessionId}` : null,
    typeof outcome.metrics.totalTokens === "number"
      ? `tokens=${outcome.metrics.totalTokens}`
      : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  return `- ${outcome.label ?? outcome.runId}: ${parts.join(" ")}\n  ${outcome.summary}`;
}

function buildDelegationDeliveryContent(input: {
  profile: string;
  mode: "single";
  outcome: SubagentOutcome;
}): string {
  return [
    `Delegation outcome for profile=${input.profile}`,
    `Mode: ${input.mode}`,
    summarizeOutcomeForDelivery(input.outcome),
  ].join("\n");
}

function buildDeliveryRecordFromRequest(
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

interface DelegationDeliveryResult {
  supplementalAppended?: boolean;
  updatedAt: number;
}

function mergeDeliveryRecord(
  delivery: DelegationRunRecord["delivery"] | undefined,
  result: DelegationDeliveryResult | undefined,
): DelegationRunRecord["delivery"] {
  if (!delivery) {
    return undefined;
  }
  if (!result) {
    return delivery;
  }
  return {
    ...delivery,
    supplementalAppended:
      typeof result.supplementalAppended === "boolean"
        ? result.supplementalAppended
        : delivery.supplementalAppended,
    updatedAt: result.updatedAt,
  };
}

function deliverDelegationOutcome(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  profile: string;
  outcome: SubagentOutcome;
  delivery: NonNullable<SubagentRunRequest["delivery"]>;
}): DelegationDeliveryResult {
  const createdAt = Date.now();
  const content = buildDelegationDeliveryContent({
    profile: input.profile,
    mode: "single",
    outcome: input.outcome,
  });
  let supplementalAppended = false;
  if (input.delivery.returnMode === "supplemental") {
    input.runtime.context.appendSupplementalInjection(
      input.sessionId,
      content,
      undefined,
      input.delivery.returnScopeId ?? `subagent:${input.profile}`,
    );
    supplementalAppended = true;
  }
  return {
    supplementalAppended,
    updatedAt: createdAt,
  };
}

function upsertDelegationRunRecord(
  runtime: BrewvaRuntime,
  sessionId: string,
  record: DelegationRunRecord,
): DelegationRunRecord {
  const cloned = cloneDelegationRunRecord(record);
  runtime.session.recordDelegationRun(sessionId, cloned);
  return cloned;
}

function resolveRunRecords(
  runtime: BrewvaRuntime,
  sessionId: string,
  query: DelegationRunQuery | undefined,
): DelegationRunRecord[] {
  return runtime.session
    .listDelegationRuns(sessionId, query)
    .map((record) => cloneDelegationRunRecord(record));
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

function createLaunchErrorResult(input: {
  mode: SubagentRunRequest["mode"];
  profile: string;
  error: string;
}): SubagentRunResult & SubagentStartResult {
  return {
    ok: false,
    mode: input.mode,
    profile: input.profile,
    outcomes: [],
    runs: [],
    error: input.error,
  };
}

export function createHostedSubagentAdapter(
  options: HostedSubagentAdapterOptions,
): NonNullable<BrewvaToolOrchestration["subagents"]> {
  const liveRunsByParentSession = new Map<string, Map<string, LiveHostedDelegationRun>>();

  function getLiveRuns(sessionId: string): Map<string, LiveHostedDelegationRun> {
    const existing = liveRunsByParentSession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, LiveHostedDelegationRun>();
    liveRunsByParentSession.set(sessionId, created);
    return created;
  }

  function removeLiveRun(sessionId: string, runId: string): void {
    const liveRuns = liveRunsByParentSession.get(sessionId);
    if (!liveRuns) {
      return;
    }
    liveRuns.delete(runId);
    if (liveRuns.size === 0) {
      liveRunsByParentSession.delete(sessionId);
    }
  }

  async function resolveLaunchPlan(input: {
    fromSessionId: string;
    request: SubagentRunRequest;
  }): Promise<
    | {
        ok: true;
        profile: HostedSubagentProfile;
        runs: Array<{
          label?: string;
          packet: DelegationPacket;
        }>;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    const profiles = await loadHostedSubagentProfiles(options.runtime.workspaceRoot);
    const profile = profiles.get(input.request.profile);
    if (!profile) {
      return {
        ok: false,
        error: `unknown_profile:${input.request.profile}`,
      };
    }

    const sharedPacket = mergeDelegationPacketWithProfileDefaults(profile, input.request.packet);
    try {
      resolveRequestedBoundary(profile, sharedPacket);
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
        profile,
        runs: [{ packet: sharedPacket }],
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
      profile,
      runs: tasks.map((task) => ({
        label: task.label,
        packet: mergeTaskPacket(sharedPacket, task),
      })),
    };
  }

  function startDelegationRun(input: {
    parentSessionId: string;
    profile: HostedSubagentProfile;
    packet: DelegationPacket;
    label?: string;
    timeoutMs?: number;
    delivery?: NonNullable<SubagentRunRequest["delivery"]>;
  }): LiveHostedDelegationRun {
    const runId = randomUUID();
    const startedAt = Date.now();
    const parentSkill = options.runtime.skills.getActive(input.parentSessionId)?.name;

    let child: HostedSubagentSessionResult | undefined;
    let isolatedWorkspace: IsolatedWorkspaceHandle | undefined;
    let childSessionId: string | undefined;
    let resolvedBoundary: SubagentExecutionBoundary | undefined;
    let childCostAggregated = false;
    let parallelSlotReleased = false;
    let cancellationReason: string | undefined;
    let timeoutTriggered = false;
    let finished = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const immediateFailure = (error: string): LiveHostedDelegationRun => {
      const failedRecord = upsertDelegationRunRecord(options.runtime, input.parentSessionId, {
        runId,
        profile: input.profile.name,
        parentSessionId: input.parentSessionId,
        status: "failed",
        createdAt: startedAt,
        updatedAt: Date.now(),
        label: input.label,
        parentSkill,
        kind: input.profile.resultMode,
        summary: error,
        error,
        delivery: buildDeliveryRecordFromRequest(input.delivery, Date.now()),
      });
      options.runtime.events.record({
        sessionId: input.parentSessionId,
        type: "subagent_failed",
        payload: {
          runId,
          profile: input.profile.name,
          label: input.label ?? null,
          kind: input.profile.resultMode,
          parentSkill: parentSkill ?? null,
          error,
          status: "failed",
          deliveryMode: input.delivery?.returnMode ?? null,
          deliveryScopeId: input.delivery?.returnScopeId ?? null,
          deliveryLabel: input.delivery?.returnLabel ?? null,
        },
      });
      return {
        record: failedRecord,
        outcomePromise: Promise.resolve(
          buildFailureOutcome({
            runId,
            profile: input.profile.name,
            label: input.label,
            error,
            startedAt,
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
      resolvedBoundary = resolveRequestedBoundary(input.profile, input.packet);
    } catch (error) {
      return immediateFailure(error instanceof Error ? error.message : String(error));
    }

    const parallel = options.runtime.tools.acquireParallelSlot(input.parentSessionId, runId);
    if (!parallel.accepted) {
      return immediateFailure(`parallel_slot_rejected:${parallel.reason ?? "unknown"}`);
    }

    const initialRecord = upsertDelegationRunRecord(options.runtime, input.parentSessionId, {
      runId,
      profile: input.profile.name,
      parentSessionId: input.parentSessionId,
      status: "pending",
      createdAt: startedAt,
      updatedAt: startedAt,
      label: input.label,
      parentSkill,
      kind: input.profile.resultMode,
      boundary: resolvedBoundary,
      delivery: buildDeliveryRecordFromRequest(input.delivery, startedAt),
    });

    options.runtime.events.record({
      sessionId: input.parentSessionId,
      type: "subagent_spawned",
      payload: {
        runId,
        profile: input.profile.name,
        label: input.label ?? null,
        kind: input.profile.resultMode,
        boundary: resolvedBoundary,
        parentSkill: parentSkill ?? null,
        status: "pending",
        deliveryMode: input.delivery?.returnMode ?? null,
        deliveryScopeId: input.delivery?.returnScopeId ?? null,
        deliveryLabel: input.delivery?.returnLabel ?? null,
      },
    });

    const liveRun: LiveHostedDelegationRun = {
      record: initialRecord,
      async cancel(reason) {
        const latest = options.runtime.session.getDelegationRun(input.parentSessionId, runId);
        if (!latest) {
          return cloneDelegationRunRecord(initialRecord);
        }
        if (isTerminalRunStatus(latest.status)) {
          return cloneDelegationRunRecord(latest);
        }
        cancellationReason = reason?.trim() || "cancelled_by_parent";
        if (child?.session.abort) {
          await child.session.abort().catch(() => undefined);
        } else if (child?.session) {
          await disposeChildSession(child.session);
        }
        await liveRun.outcomePromise.catch(() => undefined);
        return (
          options.runtime.session.getDelegationRun(input.parentSessionId, runId) ??
          cloneDelegationRunRecord(latest)
        );
      },
      getView() {
        const latest =
          options.runtime.session.getDelegationRun(input.parentSessionId, runId) ?? liveRun.record;
        const terminal = isTerminalRunStatus(latest.status);
        return {
          ...cloneDelegationRunRecord(latest),
          live: !terminal && !finished,
          cancelable: !terminal && !finished,
        };
      },
      outcomePromise: Promise.resolve(
        buildFailureOutcome({
          runId,
          profile: input.profile.name,
          label: input.label,
          error: "uninitialized",
          startedAt,
        }),
      ),
    };

    const runPromise = (async (): Promise<SubagentOutcome> => {
      try {
        const builtinToolNames = resolveBuiltinToolNamesForRun(
          options.runtime,
          input.profile,
          resolvedBoundary,
        );
        const managedToolNames = resolveManagedToolNamesForRun(
          options.runtime,
          input.profile,
          resolvedBoundary,
        );

        if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timeoutTriggered = true;
            cancellationReason = `timeout:${input.timeoutMs}`;
            void child?.session.abort?.();
          }, input.timeoutMs);
        }

        if (resolvedBoundary === "effectful") {
          isolatedWorkspace = await createIsolatedWorkspace(options.runtime.workspaceRoot);
        }

        child = await options.createChildSession({
          agentId: `subagent-${sanitizeFragment(input.profile.name) || "worker"}`,
          model: input.profile.model,
          cwd: isolatedWorkspace?.root,
          builtinToolNames,
          managedToolNames,
          enableExtensions: input.profile.enableExtensions ?? false,
          enableSubagents: false,
        });

        childSessionId = child.session.sessionManager.getSessionId();
        if (timeoutTriggered && child.session.abort) {
          await child.session.abort().catch(() => undefined);
        }
        upsertDelegationRunRecord(options.runtime, input.parentSessionId, {
          ...(options.runtime.session.getDelegationRun(input.parentSessionId, runId) ??
            initialRecord),
          status: "running",
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
        });
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: "subagent_spawned",
          payload: {
            runId,
            profile: input.profile.name,
            label: input.label ?? null,
            kind: input.profile.resultMode,
            boundary: resolvedBoundary,
            childSessionId,
            parentSkill: parentSkill ?? null,
            status: "running",
            deliveryMode: input.delivery?.returnMode ?? null,
            deliveryScopeId: input.delivery?.returnScopeId ?? null,
            deliveryLabel: input.delivery?.returnLabel ?? null,
          },
        });

        const activationSkill = input.packet.entrySkill ?? input.profile.entrySkill;
        if (activationSkill) {
          const activation = child.runtime.skills.activate(childSessionId, activationSkill);
          if (!activation.ok) {
            throw new Error(`subagent_entry_skill_failed:${activation.reason}`);
          }
        }

        const prompt = buildDelegationPrompt(input.profile, input.packet);
        const output = await collectSessionPromptOutput(
          child.session as Parameters<typeof collectSessionPromptOutput>[0],
          prompt,
        );
        const childCostSummary = child.runtime.cost.getSummary(childSessionId);
        aggregateChildCost(options.runtime, input.parentSessionId, childCostSummary);
        childCostAggregated = true;
        const summary = resolveRunSummary(
          output.assistantText,
          `Delegated ${input.profile.resultMode} run completed without a final assistant summary.`,
        );
        const patches = await captureIsolatedPatchSet(
          options.runtime.workspaceRoot,
          isolatedWorkspace,
          summary,
        );
        const workerResult =
          resolvedBoundary === "effectful"
            ? buildWorkerResult({
                workerId: runId,
                summary,
                patches,
              })
            : undefined;
        if (workerResult) {
          options.runtime.session.recordWorkerResult(input.parentSessionId, workerResult);
          parallelSlotReleased = true;
        }

        const outcome: SubagentOutcomeSuccess = {
          ok: true,
          runId,
          profile: input.profile.name,
          label: input.label,
          kind: input.profile.resultMode,
          status: "ok",
          workerSessionId: childSessionId,
          summary,
          assistantText: output.assistantText.trim(),
          metrics: {
            durationMs: Math.max(0, Date.now() - startedAt),
            inputTokens: childCostSummary.inputTokens,
            outputTokens: childCostSummary.outputTokens,
            totalTokens: childCostSummary.totalTokens,
            costUsd: childCostSummary.totalCostUsd,
          },
          patches,
          artifactRefs: buildPatchArtifactRefs(patches),
          evidenceRefs: [
            {
              sourceType: "event",
              locator: `session:${childSessionId}:agent_end`,
              summary: "Child run completed",
            },
            ...output.toolOutputs.slice(0, 8).map((toolOutput) => ({
              sourceType: "tool_result" as const,
              locator: `session:${childSessionId}:tool:${toolOutput.toolCallId}`,
              summary: `${toolOutput.toolName}:${toolOutput.verdict}`,
            })),
          ],
        };

        const deliveryResult = input.delivery
          ? deliverDelegationOutcome({
              runtime: options.runtime,
              sessionId: input.parentSessionId,
              profile: input.profile.name,
              outcome,
              delivery: input.delivery,
            })
          : undefined;

        const completedRecord = upsertDelegationRunRecord(options.runtime, input.parentSessionId, {
          ...(options.runtime.session.getDelegationRun(input.parentSessionId, runId) ??
            initialRecord),
          status: "completed",
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
          summary,
          error: undefined,
          artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
          delivery: mergeDeliveryRecord(
            options.runtime.session.getDelegationRun(input.parentSessionId, runId)?.delivery ??
              initialRecord.delivery,
            deliveryResult,
          ),
          totalTokens: childCostSummary.totalTokens,
          costUsd: childCostSummary.totalCostUsd,
        });
        liveRun.record = completedRecord;
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: "subagent_completed",
          payload: {
            runId,
            profile: input.profile.name,
            label: input.label ?? null,
            kind: input.profile.resultMode,
            childSessionId,
            boundary: resolvedBoundary,
            parentSkill: parentSkill ?? null,
            status: "completed",
            summary,
            totalTokens: childCostSummary.totalTokens,
            costUsd: childCostSummary.totalCostUsd,
            workerStatus: workerResult?.status ?? null,
            patchChangeCount: patches?.changes.length ?? 0,
            artifactRefs: outcome.artifactRefs ?? [],
            deliveryMode: completedRecord.delivery?.mode ?? null,
            deliveryScopeId: completedRecord.delivery?.scopeId ?? null,
            deliveryLabel: completedRecord.delivery?.label ?? null,
            supplementalAppended: completedRecord.delivery?.supplementalAppended ?? null,
            deliveryUpdatedAt: completedRecord.delivery?.updatedAt ?? null,
          },
        });
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (child && childSessionId && !childCostAggregated) {
          aggregateChildCost(
            options.runtime,
            input.parentSessionId,
            child.runtime.cost.getSummary(childSessionId),
          );
          childCostAggregated = true;
        }
        let workerResult: WorkerResult | undefined;
        if (resolvedBoundary === "effectful") {
          const patches = await captureIsolatedPatchSet(
            options.runtime.workspaceRoot,
            isolatedWorkspace,
            message,
          ).catch(() => undefined);
          workerResult = buildWorkerResult({
            workerId: runId,
            summary: message,
            patches,
            errorMessage: message,
          });
          options.runtime.session.recordWorkerResult(input.parentSessionId, workerResult);
          parallelSlotReleased = true;
        }
        const terminalStatus: DelegationRunRecord["status"] = timeoutTriggered
          ? "timeout"
          : cancellationReason
            ? "cancelled"
            : "failed";
        const artifactRefs = buildPatchArtifactRefs(workerResult?.patches);
        const terminalCostSummary =
          child && childSessionId ? child.runtime.cost.getSummary(childSessionId) : undefined;
        const outcome =
          terminalStatus === "cancelled" || terminalStatus === "timeout"
            ? ({
                ok: false,
                runId,
                profile: input.profile.name,
                label: input.label,
                status: terminalStatus,
                workerSessionId: childSessionId,
                error: message,
                metrics: {
                  durationMs: Math.max(0, Date.now() - startedAt),
                },
                artifactRefs,
              } satisfies SubagentOutcome)
            : buildFailureOutcome({
                runId,
                profile: input.profile.name,
                label: input.label,
                workerSessionId: childSessionId,
                artifactRefs,
                error: message,
                startedAt,
              });
        const deliveryResult = input.delivery
          ? deliverDelegationOutcome({
              runtime: options.runtime,
              sessionId: input.parentSessionId,
              profile: input.profile.name,
              outcome,
              delivery: input.delivery,
            })
          : undefined;

        const updatedRecord = upsertDelegationRunRecord(options.runtime, input.parentSessionId, {
          ...(options.runtime.session.getDelegationRun(input.parentSessionId, runId) ??
            initialRecord),
          status: terminalStatus,
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
          summary: message,
          error: message,
          artifactRefs,
          delivery: mergeDeliveryRecord(
            options.runtime.session.getDelegationRun(input.parentSessionId, runId)?.delivery ??
              initialRecord.delivery,
            deliveryResult,
          ),
          totalTokens: terminalCostSummary?.totalTokens,
          costUsd: terminalCostSummary?.totalCostUsd,
        });
        liveRun.record = updatedRecord;
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
          payload: {
            runId,
            profile: input.profile.name,
            label: input.label ?? null,
            kind: input.profile.resultMode,
            childSessionId: childSessionId ?? null,
            boundary: resolvedBoundary ?? null,
            parentSkill: parentSkill ?? null,
            error: message,
            reason: cancellationReason ?? null,
            status: terminalStatus,
            summary: message,
            workerStatus: workerResult?.status ?? null,
            patchChangeCount: workerResult?.patches?.changes.length ?? 0,
            artifactRefs: artifactRefs ?? [],
            deliveryMode: updatedRecord.delivery?.mode ?? null,
            deliveryScopeId: updatedRecord.delivery?.scopeId ?? null,
            deliveryLabel: updatedRecord.delivery?.label ?? null,
            supplementalAppended: updatedRecord.delivery?.supplementalAppended ?? null,
            deliveryUpdatedAt: updatedRecord.delivery?.updatedAt ?? null,
          },
        });
        return outcome;
      } finally {
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (!parallelSlotReleased) {
          options.runtime.tools.releaseParallelSlot(input.parentSessionId, runId);
        }
        if (child) {
          await disposeChildSession(child.session);
        }
        if (isolatedWorkspace) {
          await isolatedWorkspace.dispose();
        }
        removeLiveRun(input.parentSessionId, runId);
      }
    })();

    liveRun.outcomePromise = runPromise;
    getLiveRuns(input.parentSessionId).set(runId, liveRun);
    return liveRun;
  }

  options.runtime.session.onClearState((sessionId) => {
    if (options.backgroundController?.cancelSessionRuns) {
      void options.backgroundController.cancelSessionRuns(sessionId, "parent_session_cleared");
    }
    const liveRuns = liveRunsByParentSession.get(sessionId);
    if (!liveRuns) {
      return;
    }
    for (const run of liveRuns.values()) {
      void run.cancel("parent_session_cleared");
    }
    liveRunsByParentSession.delete(sessionId);
  });

  return {
    run: async ({ fromSessionId, request }): Promise<SubagentRunResult> => {
      const launchPlan = await resolveLaunchPlan({ fromSessionId, request });
      if (!launchPlan.ok) {
        return createLaunchErrorResult({
          mode: request.mode,
          profile: request.profile,
          error: launchPlan.error,
        });
      }

      const liveRuns = launchPlan.runs.map((run) =>
        startDelegationRun({
          parentSessionId: fromSessionId,
          profile: launchPlan.profile,
          packet: run.packet,
          label: run.label,
          timeoutMs: request.timeoutMs,
        }),
      );
      const outcomes = await Promise.all(liveRuns.map((run) => run.outcomePromise));
      return {
        ok: outcomes.every((outcome) => outcome.ok),
        mode: request.mode,
        profile: request.profile,
        outcomes,
        error: outcomes.find((outcome) => !outcome.ok)?.error,
      };
    },
    start: async ({ fromSessionId, request }): Promise<SubagentStartResult> => {
      const launchPlan = await resolveLaunchPlan({ fromSessionId, request });
      if (!launchPlan.ok) {
        const failure = createLaunchErrorResult({
          mode: request.mode,
          profile: request.profile,
          error: launchPlan.error,
        });
        return {
          ok: failure.ok,
          mode: failure.mode,
          profile: failure.profile,
          runs: failure.runs,
          error: failure.error,
        };
      }

      if (options.backgroundController) {
        const runs = await Promise.all(
          launchPlan.runs.map((run) =>
            options.backgroundController!.startRun({
              parentSessionId: fromSessionId,
              profile: launchPlan.profile,
              packet: run.packet,
              label: run.label,
              timeoutMs: request.timeoutMs,
              delivery: request.delivery,
            }),
          ),
        );
        return {
          ok: runs.every((run) => run.status !== "failed"),
          mode: request.mode,
          profile: request.profile,
          runs: runs.map((run) => cloneDelegationRunRecord(run)),
          error: runs.find((run) => run.status === "failed")?.error,
        };
      }

      const liveRuns = launchPlan.runs.map((run) =>
        startDelegationRun({
          parentSessionId: fromSessionId,
          profile: launchPlan.profile,
          packet: run.packet,
          label: run.label,
          timeoutMs: request.timeoutMs,
          delivery: request.delivery,
        }),
      );
      return {
        ok: liveRuns.every((run) => run.record.status !== "failed"),
        mode: request.mode,
        profile: request.profile,
        runs: liveRuns.map((run) => cloneDelegationRunRecord(run.record)),
        error: liveRuns.find((run) => run.record.status === "failed")?.record.error,
      };
    },
    status: async ({ fromSessionId, query }): Promise<SubagentStatusResult> => {
      const backgroundLiveStates = options.backgroundController
        ? await options.backgroundController.inspectLiveRuns({
            parentSessionId: fromSessionId,
            query,
          })
        : undefined;
      const persistedRuns = resolveRunRecords(options.runtime, fromSessionId, query);
      const liveRuns = liveRunsByParentSession.get(fromSessionId);
      const runs = persistedRuns.map((record) => {
        const liveRun = liveRuns?.get(record.runId);
        const backgroundLive = backgroundLiveStates?.get(record.runId);
        return {
          runId: record.runId,
          profile: record.profile,
          parentSessionId: record.parentSessionId,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          label: record.label,
          workerSessionId: record.workerSessionId,
          parentSkill: record.parentSkill,
          kind: record.kind,
          boundary: record.boundary,
          summary: record.summary,
          error: record.error,
          artifactRefs: record.artifactRefs?.map((ref) => ({
            kind: ref.kind,
            path: ref.path,
            summary: ref.summary,
          })),
          delivery: record.delivery
            ? {
                mode: record.delivery.mode,
                scopeId: record.delivery.scopeId,
                label: record.delivery.label,
                supplementalAppended: record.delivery.supplementalAppended,
                updatedAt: record.delivery.updatedAt,
              }
            : undefined,
          totalTokens: record.totalTokens,
          costUsd: record.costUsd,
          live: backgroundLive?.live ?? (!!liveRun && !isTerminalRunStatus(record.status)),
          cancelable:
            backgroundLive?.cancelable ?? (!!liveRun && !isTerminalRunStatus(record.status)),
        };
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
      const liveRun = liveRunsByParentSession.get(fromSessionId)?.get(runId);
      if (!liveRun) {
        const persisted = options.runtime.session.getDelegationRun(fromSessionId, runId);
        if (!persisted) {
          return {
            ok: false,
            error: `unknown_run:${runId}`,
          };
        }
        if (isTerminalRunStatus(persisted.status)) {
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
      return {
        ok: record.status === "cancelled" || record.status === "timeout",
        run: {
          ...cloneDelegationRunRecord(record),
          live: false,
          cancelable: false,
        },
        error:
          record.status === "cancelled" || record.status === "timeout"
            ? undefined
            : `cancel_not_observed:${record.status}`,
      };
    },
  };
}
