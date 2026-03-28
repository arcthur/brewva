import { randomUUID } from "node:crypto";
import type {
  BrewvaConfig,
  BrewvaRuntime,
  DelegationRunQuery,
  DelegationRunRecord,
  ManagedToolMode,
  PatchSet,
  WorkerResult,
} from "@brewva/brewva-runtime";
import type {
  BrewvaToolOrchestration,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentCancelResult,
  SubagentOutcomeArtifactRef,
  SubagentOutcome,
  SubagentOutcomeSuccess,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
  SubagentStatusResult,
} from "@brewva/brewva-tools";
import { collectSessionPromptOutput } from "../session/collect-output.js";
import type { SubscribablePromptSession } from "../session/contracts.js";
import type { HostedSubagentBackgroundController } from "./background-controller.js";
import { writeDetachedSubagentContextManifest } from "./background-protocol.js";
import { loadHostedDelegationCatalog } from "./catalog.js";
import { HostedDelegationStore, cloneDelegationRunRecord } from "./delegation-store.js";
import type { DelegationModelRoutingContext } from "./model-routing.js";
import { buildDelegationPrompt } from "./prompt.js";
import {
  aggregateChildCost,
  buildPatchArtifactRefs,
  buildWorkerResult,
  formatSkillValidationError,
  resolveDelegationExecutionPlan,
  resolveDelegationTarget,
  resolveRunSummary,
  sanitizeFragment,
} from "./shared.js";
import {
  extractStructuredOutcomeData,
  summarizeStructuredOutcomeData,
} from "./structured-outcome.js";
import {
  mergeDelegationPacketWithTargetDefaults,
  type HostedDelegationBuiltinToolName,
  type HostedDelegationTarget,
} from "./targets.js";
import {
  capturePatchSetFromIsolatedWorkspace,
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
  orchestration?: BrewvaToolOrchestration;
}

export interface HostedSubagentSessionResult {
  runtime: BrewvaRuntime;
  session: SubscribablePromptSession & {
    dispose(): void;
    abort?(): Promise<void>;
    sessionManager: {
      getSessionId(): string;
    };
  };
}

export interface HostedSubagentAdapterOptions {
  runtime: BrewvaRuntime;
  createChildSession(input: HostedSubagentSessionOptions): Promise<HostedSubagentSessionResult>;
  backgroundController?: HostedSubagentBackgroundController;
  delegationStore?: HostedDelegationStore;
  modelRouting?: DelegationModelRoutingContext;
}

function mergeTaskPacket(
  sharedPacket: DelegationPacket | undefined,
  taskPacket: DelegationTaskPacket,
): DelegationPacket {
  const effectCeilingBoundary =
    taskPacket.effectCeiling?.boundary ?? sharedPacket?.effectCeiling?.boundary;
  return {
    objective: taskPacket.objective,
    deliverable: taskPacket.deliverable ?? sharedPacket?.deliverable,
    constraints: [...(sharedPacket?.constraints ?? []), ...(taskPacket.constraints ?? [])],
    sharedNotes: [...(sharedPacket?.sharedNotes ?? []), ...(taskPacket.sharedNotes ?? [])],
    activeSkillName: taskPacket.activeSkillName ?? sharedPacket?.activeSkillName,
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
    completionPredicate: taskPacket.completionPredicate ?? sharedPacket?.completionPredicate,
    effectCeiling: effectCeilingBoundary ? { boundary: effectCeilingBoundary } : undefined,
  };
}

function buildFailureOutcome(input: {
  runId: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  workerSessionId?: string;
  artifactRefs?: SubagentOutcomeArtifactRef[];
  error: string;
  startedAt: number;
}): SubagentOutcome {
  return {
    ok: false,
    runId: input.runId,
    delegate: input.delegate,
    agentSpec: input.agentSpec,
    envelope: input.envelope,
    skillName: input.skillName,
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

function resolveDelegationRecordIdentity(input: {
  target: HostedDelegationTarget;
  delegatedSkillName?: string;
}): Pick<DelegationRunRecord, "delegate" | "agentSpec" | "envelope" | "skillName"> {
  return {
    delegate: input.target.agentSpecName ?? input.target.envelopeName ?? input.target.name,
    agentSpec: input.target.agentSpecName,
    envelope: input.target.envelopeName,
    skillName: input.delegatedSkillName ?? input.target.skillName,
  };
}

function resolveDelegationLabel(target: HostedDelegationTarget): string {
  return target.agentSpecName ?? target.envelopeName ?? target.skillName ?? target.name;
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
  delegate: string;
  mode: "single";
  outcome: SubagentOutcome;
}): string {
  return [
    `Delegation outcome for delegate=${input.delegate}`,
    `Mode: ${input.mode}`,
    summarizeOutcomeForDelivery(input.outcome),
  ].join("\n");
}

function buildDeliveryRecordFromRequest(
  delivery: SubagentRunRequest["delivery"] | undefined,
  updatedAt: number,
  defaults: {
    handoffState?: NonNullable<DelegationRunRecord["delivery"]>["handoffState"];
    forceTextOnly?: boolean;
  } = {},
): DelegationRunRecord["delivery"] {
  if (!delivery && !defaults.forceTextOnly) {
    return undefined;
  }
  return {
    mode: delivery?.returnMode ?? "text_only",
    scopeId: delivery?.returnScopeId,
    label: delivery?.returnLabel,
    handoffState: defaults.handoffState ?? "none",
    updatedAt,
  };
}

interface DelegationDeliveryResult {
  supplementalAppended?: boolean;
  handoffState?: NonNullable<DelegationRunRecord["delivery"]>["handoffState"];
  readyAt?: number;
  surfacedAt?: number;
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
    handoffState: result.handoffState ?? delivery.handoffState,
    readyAt: result.readyAt ?? delivery.readyAt,
    surfacedAt: result.surfacedAt ?? delivery.surfacedAt,
    updatedAt: result.updatedAt,
  };
}

function deliverDelegationOutcome(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  delegate: string;
  outcome: SubagentOutcome;
  delivery: NonNullable<SubagentRunRequest["delivery"]>;
}): DelegationDeliveryResult {
  const createdAt = Date.now();
  const content = buildDelegationDeliveryContent({
    delegate: input.delegate,
    mode: "single",
    outcome: input.outcome,
  });
  let supplementalAppended = false;
  if (input.delivery.returnMode === "supplemental") {
    input.runtime.context.appendSupplementalInjection(
      input.sessionId,
      content,
      undefined,
      input.delivery.returnScopeId ?? `subagent:${input.delegate}`,
    );
    supplementalAppended = true;
  }
  return {
    supplementalAppended,
    updatedAt: createdAt,
  };
}

function preparePendingParentTurnDelivery(): DelegationDeliveryResult {
  const readyAt = Date.now();
  return {
    handoffState: "pending_parent_turn",
    readyAt,
    supplementalAppended: false,
    updatedAt: readyAt,
  };
}

function resolveRunRecords(
  delegationStore: HostedDelegationStore,
  sessionId: string,
  query: DelegationRunQuery | undefined,
): DelegationRunRecord[] {
  return delegationStore
    .listRuns(sessionId, query)
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
  delegate: string;
  error: string;
}): SubagentRunResult & SubagentStartResult {
  return {
    ok: false,
    mode: input.mode,
    delegate: input.delegate,
    outcomes: [],
    runs: [],
    error: input.error,
  };
}

export function createHostedSubagentAdapter(
  options: HostedSubagentAdapterOptions,
): NonNullable<BrewvaToolOrchestration["subagents"]> {
  const delegationStore = options.delegationStore ?? new HostedDelegationStore(options.runtime);
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
        target: HostedDelegationTarget;
        delegate: string;
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
    const catalog = await loadHostedDelegationCatalog(options.runtime.workspaceRoot);
    let resolvedTarget;
    try {
      resolvedTarget = resolveDelegationTarget({
        request: {
          agentSpec: input.request.agentSpec,
          envelope: input.request.envelope,
          skillName: input.request.skillName,
          fallbackResultMode: input.request.fallbackResultMode,
          executionShape: input.request.executionShape,
        },
        catalog,
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const sharedPacket = mergeDelegationPacketWithTargetDefaults(
      resolvedTarget.target,
      input.request.packet,
    );
    if (
      resolvedTarget.target.skillName &&
      !options.runtime.skills.get(resolvedTarget.target.skillName)
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
      target: resolvedTarget.target,
      delegate: resolvedTarget.delegate,
      runs: tasks.map((task) => ({
        label: task.label,
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
    timeoutMs?: number;
    delivery?: NonNullable<SubagentRunRequest["delivery"]>;
  }): LiveHostedDelegationRun {
    const runId = randomUUID();
    const startedAt = Date.now();
    const parentSkill = options.runtime.skills.getActive(input.parentSessionId)?.name;
    const delegate = input.delegate ?? resolveDelegationLabel(input.target);

    let child: HostedSubagentSessionResult | undefined;
    let isolatedWorkspace: IsolatedWorkspaceHandle | undefined;
    let childSessionId: string | undefined;
    let executionPlan: ReturnType<typeof resolveDelegationExecutionPlan> | undefined;
    let childCostAggregated = false;
    let parallelSlotReleased = false;
    let cancellationReason: string | undefined;
    let timeoutTriggered = false;
    let finished = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const immediateFailure = (error: string): LiveHostedDelegationRun => {
      const failedRecord: DelegationRunRecord = {
        runId,
        ...resolveDelegationRecordIdentity({ target: input.target }),
        parentSessionId: input.parentSessionId,
        status: "failed",
        createdAt: startedAt,
        updatedAt: Date.now(),
        label: input.label,
        parentSkill,
        kind: input.target.resultMode,
        summary: error,
        error,
        delivery: buildDeliveryRecordFromRequest(input.delivery, Date.now()),
      };
      options.runtime.events.record({
        sessionId: input.parentSessionId,
        type: "subagent_failed",
        payload: {
          runId,
          delegate,
          agentSpec: input.target.agentSpecName ?? null,
          envelope: input.target.envelopeName ?? null,
          skillName: input.target.skillName ?? null,
          label: input.label ?? null,
          kind: input.target.resultMode,
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
            delegate,
            agentSpec: input.target.agentSpecName,
            envelope: input.target.envelopeName,
            skillName: input.target.skillName,
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

    const parallel = options.runtime.tools.acquireParallelSlot(input.parentSessionId, runId);
    if (!parallel.accepted) {
      return immediateFailure(`parallel_slot_rejected:${parallel.reason ?? "unknown"}`);
    }

    const initialRecord: DelegationRunRecord = {
      runId,
      ...resolveDelegationRecordIdentity({ target: input.target }),
      parentSessionId: input.parentSessionId,
      status: "pending",
      createdAt: startedAt,
      updatedAt: startedAt,
      label: input.label,
      parentSkill,
      kind: input.target.resultMode,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
      delivery: buildDeliveryRecordFromRequest(input.delivery, startedAt),
    };

    options.runtime.events.record({
      sessionId: input.parentSessionId,
      type: "subagent_spawned",
      payload: {
        runId,
        delegate,
        agentSpec: input.target.agentSpecName ?? null,
        envelope: input.target.envelopeName ?? null,
        skillName: input.target.skillName ?? null,
        label: input.label ?? null,
        kind: input.target.resultMode,
        boundary: executionPlan.boundary,
        modelRoute: executionPlan.modelRoute ?? null,
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
        const latest = delegationStore.getRun(input.parentSessionId, runId);
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
          delegationStore.getRun(input.parentSessionId, runId) ?? cloneDelegationRunRecord(latest)
        );
      },
      getView() {
        const latest = delegationStore.getRun(input.parentSessionId, runId) ?? liveRun.record;
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
          delegate,
          agentSpec: input.target.agentSpecName,
          envelope: input.target.envelopeName,
          skillName: input.target.skillName,
          label: input.label,
          error: "uninitialized",
          startedAt,
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

        writeDetachedSubagentContextManifest(options.runtime.workspaceRoot, runId, {
          schema: "brewva.delegation-context-manifest.v1",
          runId,
          delegate,
          resultMode: input.target.resultMode,
          generatedAt: Date.now(),
          objective: input.packet.objective,
          contextRefs: input.packet.contextRefs ?? [],
        });
        if (executionPlan.boundary === "effectful") {
          isolatedWorkspace = await createIsolatedWorkspace(options.runtime.workspaceRoot);
          await copyDelegationContextManifestToIsolatedWorkspace({
            sourceRoot: options.runtime.workspaceRoot,
            isolatedRoot: isolatedWorkspace.root,
            runId,
          });
        }

        child = await options.createChildSession({
          agentId: `subagent-${sanitizeFragment(delegate) || "worker"}`,
          model: executionPlan.model,
          cwd: isolatedWorkspace?.root,
          config: structuredClone(options.runtime.config) as BrewvaConfig,
          builtinToolNames: executionPlan.builtinToolNames,
          managedToolNames: executionPlan.managedToolNames,
          managedToolMode: executionPlan.managedToolMode,
          enableSubagents: false,
        });

        childSessionId = child.session.sessionManager.getSessionId();
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
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: "subagent_spawned",
          payload: {
            runId,
            delegate,
            agentSpec: input.target.agentSpecName ?? null,
            envelope: input.target.envelopeName ?? null,
            skillName: input.target.skillName ?? null,
            label: input.label ?? null,
            kind: input.target.resultMode,
            boundary: executionPlan.boundary,
            modelRoute: executionPlan.modelRoute ?? null,
            childSessionId,
            parentSkill: parentSkill ?? null,
            status: "running",
            deliveryMode: input.delivery?.returnMode ?? null,
            deliveryScopeId: input.delivery?.returnScopeId ?? null,
            deliveryLabel: input.delivery?.returnLabel ?? null,
          },
        });

        const delegatedSkill = input.target.skillName;
        const skillDocument = delegatedSkill
          ? options.runtime.skills.get(delegatedSkill)
          : undefined;
        if (delegatedSkill && !skillDocument) {
          throw new Error(`unknown_skill:${delegatedSkill}`);
        }
        if (delegatedSkill) {
          const activation = child.runtime.skills.activate(childSessionId, delegatedSkill);
          if (!activation.ok) {
            throw new Error(`subagent_entry_skill_failed:${activation.reason}`);
          }
        }

        const prompt = buildDelegationPrompt({
          target: input.target,
          packet: input.packet,
          promptOverride: executionPlan.prompt,
          skill: skillDocument,
        });
        const output = await collectSessionPromptOutput(child.session, prompt);
        const childCostSummary = child.runtime.cost.getSummary(childSessionId);
        aggregateChildCost(options.runtime, input.parentSessionId, childCostSummary);
        childCostAggregated = true;
        const structuredOutcome = extractStructuredOutcomeData({
          resultMode: input.target.resultMode,
          assistantText: output.assistantText,
          skillName: delegatedSkill,
        });
        if (structuredOutcome.parseError) {
          options.runtime.events.record({
            sessionId: input.parentSessionId,
            type: "subagent_outcome_parse_failed",
            payload: {
              runId,
              delegate,
              label: input.label ?? null,
              kind: input.target.resultMode,
              childSessionId,
              error: structuredOutcome.parseError,
            },
          });
        }
        const skillValidation =
          delegatedSkill && childSessionId
            ? child.runtime.skills.validateOutputs(
                childSessionId,
                structuredOutcome.skillOutputs ?? {},
              )
            : undefined;
        if (delegatedSkill && skillValidation && !skillValidation.ok) {
          options.runtime.events.record({
            sessionId: input.parentSessionId,
            type: "subagent_skill_output_validation_failed",
            payload: {
              runId,
              delegate,
              label: input.label ?? null,
              kind: input.target.resultMode,
              childSessionId,
              skillName: delegatedSkill,
              missing: skillValidation.missing,
              invalid: skillValidation.invalid,
            },
          });
          throw new Error(
            formatSkillValidationError({
              skillName: delegatedSkill,
              missing: skillValidation.missing,
              invalid: skillValidation.invalid,
            }),
          );
        }
        const fallbackSummary =
          structuredOutcome.data && summarizeStructuredOutcomeData(structuredOutcome.data)
            ? summarizeStructuredOutcomeData(structuredOutcome.data)!
            : `Delegated ${input.target.resultMode} run completed without a final assistant summary.`;
        const summary = resolveRunSummary(
          structuredOutcome.narrativeText || output.assistantText,
          fallbackSummary,
        );
        const patches = await captureIsolatedPatchSet(
          options.runtime.workspaceRoot,
          isolatedWorkspace,
          summary,
        );
        const workerResult =
          executionPlan.boundary === "effectful"
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
          delegate,
          agentSpec: input.target.agentSpecName,
          envelope: input.target.envelopeName,
          skillName: delegatedSkill,
          label: input.label,
          kind: input.target.resultMode,
          status: "ok",
          workerSessionId: childSessionId,
          summary,
          assistantText: output.assistantText.trim(),
          data: structuredOutcome.data,
          skillOutputs: structuredOutcome.skillOutputs,
          skillValidation,
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
              kind: "event",
              locator: `session:${childSessionId}:agent_end`,
              summary: "Child run completed",
              sourceSessionId: childSessionId,
            },
            ...output.toolOutputs.slice(0, 8).map((toolOutput) => ({
              kind: "tool_result" as const,
              locator: `session:${childSessionId}:tool:${toolOutput.toolCallId}`,
              summary: `${toolOutput.toolName}:${toolOutput.verdict}`,
              sourceSessionId: childSessionId,
            })),
          ],
        };

        const deliveryResult = input.delivery
          ? input.delivery.returnMode === "supplemental"
            ? deliverDelegationOutcome({
                runtime: options.runtime,
                sessionId: input.parentSessionId,
                delegate,
                outcome,
                delivery: input.delivery,
              })
            : preparePendingParentTurnDelivery()
          : undefined;

        const completedRecord: DelegationRunRecord = {
          ...(delegationStore.getRun(input.parentSessionId, runId) ?? initialRecord),
          ...resolveDelegationRecordIdentity({
            target: input.target,
            delegatedSkillName: delegatedSkill,
          }),
          status: "completed",
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
          modelRoute: executionPlan.modelRoute,
          summary,
          error: undefined,
          artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
          delivery: mergeDeliveryRecord(
            delegationStore.getRun(input.parentSessionId, runId)?.delivery ??
              initialRecord.delivery,
            deliveryResult,
          ),
          totalTokens: childCostSummary.totalTokens,
          costUsd: childCostSummary.totalCostUsd,
        };
        liveRun.record = completedRecord;
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: "subagent_completed",
          payload: {
            runId,
            delegate,
            agentSpec: input.target.agentSpecName ?? null,
            envelope: input.target.envelopeName ?? null,
            skillName: delegatedSkill ?? null,
            label: input.label ?? null,
            kind: input.target.resultMode,
            childSessionId,
            boundary: executionPlan.boundary,
            modelRoute: executionPlan.modelRoute ?? null,
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
            deliveryHandoffState: completedRecord.delivery?.handoffState ?? null,
            deliveryReadyAt: completedRecord.delivery?.readyAt ?? null,
            deliverySurfacedAt: completedRecord.delivery?.surfacedAt ?? null,
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
        if (executionPlan.boundary === "effectful") {
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
                delegate,
                agentSpec: input.target.agentSpecName,
                envelope: input.target.envelopeName,
                skillName: input.target.skillName,
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
                delegate,
                agentSpec: input.target.agentSpecName,
                envelope: input.target.envelopeName,
                skillName: input.target.skillName,
                label: input.label,
                workerSessionId: childSessionId,
                artifactRefs,
                error: message,
                startedAt,
              });
        const deliveryResult = input.delivery
          ? input.delivery.returnMode === "supplemental"
            ? deliverDelegationOutcome({
                runtime: options.runtime,
                sessionId: input.parentSessionId,
                delegate,
                outcome,
                delivery: input.delivery,
              })
            : preparePendingParentTurnDelivery()
          : undefined;

        const updatedRecord: DelegationRunRecord = {
          ...(delegationStore.getRun(input.parentSessionId, runId) ?? initialRecord),
          ...resolveDelegationRecordIdentity({
            target: input.target,
            delegatedSkillName: input.target.skillName,
          }),
          status: terminalStatus,
          updatedAt: Date.now(),
          workerSessionId: childSessionId,
          modelRoute: executionPlan.modelRoute,
          summary: message,
          error: message,
          artifactRefs,
          delivery: mergeDeliveryRecord(
            delegationStore.getRun(input.parentSessionId, runId)?.delivery ??
              initialRecord.delivery,
            deliveryResult,
          ),
          totalTokens: terminalCostSummary?.totalTokens,
          costUsd: terminalCostSummary?.totalCostUsd,
        };
        liveRun.record = updatedRecord;
        options.runtime.events.record({
          sessionId: input.parentSessionId,
          type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
          payload: {
            runId,
            delegate,
            agentSpec: input.target.agentSpecName ?? null,
            envelope: input.target.envelopeName ?? null,
            skillName: input.target.skillName ?? null,
            label: input.label ?? null,
            kind: input.target.resultMode,
            childSessionId: childSessionId ?? null,
            boundary: executionPlan.boundary ?? null,
            modelRoute: executionPlan.modelRoute ?? null,
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
            deliveryHandoffState: updatedRecord.delivery?.handoffState ?? null,
            deliveryReadyAt: updatedRecord.delivery?.readyAt ?? null,
            deliverySurfacedAt: updatedRecord.delivery?.surfacedAt ?? null,
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
    delegationStore.clearSession(sessionId);
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
          delegate:
            request.agentSpec ??
            request.envelope ??
            request.skillName ??
            request.executionShape?.resultMode ??
            "derived",
          error: launchPlan.error,
        });
      }

      const liveRuns = launchPlan.runs.map((run) =>
        startDelegationRun({
          parentSessionId: fromSessionId,
          target: launchPlan.target,
          delegate: launchPlan.delegate,
          packet: run.packet,
          executionShape: request.executionShape,
          label: run.label,
          timeoutMs: request.timeoutMs,
        }),
      );
      const outcomes = await Promise.all(liveRuns.map((run) => run.outcomePromise));
      return {
        ok: outcomes.every((outcome) => outcome.ok),
        mode: request.mode,
        delegate: launchPlan.delegate,
        outcomes,
        error: outcomes.find((outcome) => !outcome.ok)?.error,
      };
    },
    start: async ({ fromSessionId, request }): Promise<SubagentStartResult> => {
      const launchPlan = await resolveLaunchPlan({ fromSessionId, request });
      if (!launchPlan.ok) {
        const failure = createLaunchErrorResult({
          mode: request.mode,
          delegate:
            request.agentSpec ??
            request.envelope ??
            request.skillName ??
            request.executionShape?.resultMode ??
            "derived",
          error: launchPlan.error,
        });
        return {
          ok: failure.ok,
          mode: failure.mode,
          delegate: failure.delegate,
          runs: failure.runs,
          error: failure.error,
        };
      }

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
              timeoutMs: request.timeoutMs,
              delivery: request.delivery,
            }),
          ),
        );
        return {
          ok: runs.every((run) => run.status !== "failed"),
          mode: request.mode,
          delegate: launchPlan.delegate,
          runs: runs.map((run) => cloneDelegationRunRecord(run)),
          error: runs.find((run) => run.status === "failed")?.error,
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
          timeoutMs: request.timeoutMs,
          delivery: request.delivery,
        }),
      );
      return {
        ok: liveRuns.every((run) => run.record.status !== "failed"),
        mode: request.mode,
        delegate: launchPlan.delegate,
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
      const persistedRuns = resolveRunRecords(delegationStore, fromSessionId, query);
      const liveRuns = liveRunsByParentSession.get(fromSessionId);
      const runs = persistedRuns.map((record) => {
        const liveRun = liveRuns?.get(record.runId);
        const backgroundLive = backgroundLiveStates?.get(record.runId);
        return {
          runId: record.runId,
          delegate: record.delegate,
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
                handoffState: record.delivery.handoffState,
                readyAt: record.delivery.readyAt,
                surfacedAt: record.delivery.surfacedAt,
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
        const persisted = delegationStore.getRun(fromSessionId, runId);
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
