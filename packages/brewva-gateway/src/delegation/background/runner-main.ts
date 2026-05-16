import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  evaluateDelegationAdoption,
} from "@brewva/brewva-runtime/delegation";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import { SUBAGENT_RUNNING_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type {
  ExplorerConsultKind,
  SubagentAgent,
  SubagentOutcome,
  SubagentOutcomeArtifactRef,
  SubagentRunRequest,
} from "@brewva/brewva-tools/contracts";
import {
  createHostedSession,
  resolveSubagentSessionShutdownReason,
  runHostedTurnEnvelope,
} from "../../hosted/api.js";
import { recordSessionShutdownIfMissing } from "../../utils/runtime.js";
import {
  buildCompletedDelegationAdoption,
  buildDelegationRunRecordSeed,
} from "../delegation-records.js";
import { HostedDelegationStore, buildDelegationLifecyclePayload } from "../delegation-store.js";
import { prepareSubagentEntry } from "../entry.js";
import { resolveDelegationExecutionPlan } from "../execution-plan.js";
import { renderInheritedSubagentContext } from "../fork-context.js";
import { ensureDelegationLineageNode, recordDelegationLineageOutcome } from "../lineage.js";
import { createDelegationModelRoutingContextFromAgentDir } from "../model-routing.js";
import {
  aggregateChildCost,
  buildPatchArtifactRefs,
  buildWorkerResult,
  resolveRunSummary,
} from "../run-finalization.js";
import { buildSubagentAgentId } from "../shared.js";
import {
  extractStructuredOutcomeData,
  summarizeStructuredOutcomeData,
} from "../structured-outcome.js";
import {
  mergeDelegationPacketWithTargetDefaults,
  type HostedDelegationTarget,
} from "../targets.js";
import {
  capturePatchSetFromIsolatedWorkspace,
  collectChangedPathsFromIsolatedWorkspace,
  copyDelegationContextManifestToIsolatedWorkspace,
  createIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "../workspace.js";
import {
  readDetachedSubagentCancelRequest,
  removeDetachedSubagentCancelRequest,
  removeDetachedSubagentLiveState,
  resolveDetachedSubagentOutcomePath,
  type DetachedSubagentRunSpec,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentOutcome,
} from "./protocol.js";

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hostedSessionLogger = {
  warn(message: string, fields?: Record<string, unknown>) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        message,
        component: "detached_subagent_runner",
        ...fields,
      }),
    );
  },
};

function buildOutcomeArtifactRef(workspaceRoot: string, runId: string): SubagentOutcomeArtifactRef {
  return {
    kind: "delegation_outcome",
    path: normalizeRelativePath(
      relative(workspaceRoot, resolveDetachedSubagentOutcomePath(workspaceRoot, runId)),
    ),
    summary: `Detached delegation outcome for ${runId}`,
  };
}

function buildFailureOutcome(input: {
  runId: string;
  agent: SubagentAgent;
  taskName: string;
  taskPath: string;
  nickname: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  consultKind?: ExplorerConsultKind;
  label?: string;
  workerSessionId?: string;
  artifactRefs?: SubagentOutcomeArtifactRef[];
  error: string;
  startedAt: number;
  status?: "error" | "cancelled" | "timeout";
}): SubagentOutcome {
  return {
    ok: false,
    runId: input.runId,
    agent: input.agent,
    taskName: input.taskName,
    taskPath: input.taskPath,
    nickname: input.nickname,
    delegate: input.delegate,
    agentSpec: input.agentSpec,
    envelope: input.envelope,
    skillName: input.skillName,
    ...(input.consultKind ? { consultKind: input.consultKind } : {}),
    label: input.label,
    status: input.status ?? "error",
    workerSessionId: input.workerSessionId,
    error: input.error,
    metrics: {
      durationMs: Math.max(0, Date.now() - input.startedAt),
    },
    artifactRefs: input.artifactRefs,
  };
}

function applyDurableDelivery(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  delegate: string;
  outcome: SubagentOutcome;
  delivery: NonNullable<SubagentRunRequest["delivery"]> | undefined;
}): DelegationRunRecord["delivery"] | undefined {
  const createdAt = Date.now();
  const deliveryRecord: NonNullable<DelegationRunRecord["delivery"]> = {
    mode: input.delivery?.returnMode ?? "text_only",
    scopeId: input.delivery?.returnScopeId,
    label: input.delivery?.returnLabel,
    handoffState: "pending_parent_turn",
    readyAt: createdAt,
    supplementalAppended: false,
    updatedAt: createdAt,
  };
  return deliveryRecord;
}

async function loadSpec(path: string): Promise<DetachedSubagentRunSpec> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const schema =
    typeof raw.schema === "string" ? raw.schema : "missing_detached_subagent_spec_schema";
  if (schema !== "brewva.subagent-run-spec.v7") {
    throw new Error(`unsupported_detached_subagent_spec_schema:${schema}`);
  }
  if (!isRecord(raw.target)) {
    throw new Error("invalid_detached_subagent_spec:missing_target");
  }
  return {
    ...raw,
    schema: "brewva.subagent-run-spec.v7",
  } as unknown as DetachedSubagentRunSpec;
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    process.exitCode = 1;
    return;
  }

  const spec = await loadSpec(specPath);
  const specParentSessionId = asBrewvaSessionId(spec.parentSessionId);
  const parentRuntime = createBrewvaRuntime({
    cwd: spec.workspaceRoot,
    config: spec.config,
    configPath: spec.configPath,
  }).hosted;
  const delegationStore = new HostedDelegationStore(parentRuntime);
  const existing = delegationStore.getRun(spec.parentSessionId, spec.runId);
  const target = spec.target;

  const delegationTarget = target;
  const packet = mergeDelegationPacketWithTargetDefaults(delegationTarget, spec.packet);
  if (!packet) {
    const failed = {
      ...(existing ?? {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: spec.runId,
        agent: target.agent,
        targetName: target.targetName,
        delegate: spec.delegate,
        taskName: spec.taskName,
        taskPath: spec.taskPath,
        nickname: spec.nickname,
        depth: spec.depth,
        forkTurns: spec.forkTurns,
        gateReason: target.gateReason,
        modelCategory: target.modelCategory,
        executionPrimitive: "named" as const,
        visibility: target.visibility,
        isolationStrategy: target.isolationStrategy,
        adoption: evaluateDelegationAdoption({ outcomeKind: target.resultMode }),
        parentSessionId: specParentSessionId,
        status: "failed" as const,
        createdAt: spec.createdAt,
        updatedAt: Date.now(),
      }),
      status: "failed" as const,
      updatedAt: Date.now(),
      error: "missing_delegation_packet",
      summary: "missing_delegation_packet",
    };
    parentRuntime.extensions.hosted.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_failed",
      payload: buildDelegationLifecyclePayload(failed),
    });
    recordDelegationLineageOutcome({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      record: failed,
    });
    removeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId);
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  let childSession: Awaited<ReturnType<typeof createHostedSession>> | undefined;
  let isolatedWorkspace: IsolatedWorkspaceHandle | undefined;
  let cancellationReason: string | undefined;
  let timeoutTriggered = false;
  let childSessionId: import("@brewva/brewva-runtime/core").BrewvaSessionId | undefined;
  let targetRecord: HostedDelegationTarget = delegationTarget;
  const modelRouting = createDelegationModelRoutingContextFromAgentDir();
  const executionPlan = resolveDelegationExecutionPlan({
    runtime: parentRuntime,
    target: targetRecord,
    delegate: spec.delegate,
    packet,
    executionShape: spec.executionShape,
    modelRouting,
    preselectedModelRoute: spec.modelRoute,
  });

  const readCancelReason = (): string | undefined =>
    readDetachedSubagentCancelRequest(spec.workspaceRoot, spec.runId)?.reason;

  process.on("SIGTERM", () => {
    cancellationReason = readCancelReason() ?? "cancelled_by_parent";
    void childSession?.session.abort?.();
  });
  process.on("SIGINT", () => {
    cancellationReason = readCancelReason() ?? "cancelled_by_parent";
    void childSession?.session.abort?.();
  });

  try {
    if (executionPlan.boundary === "effectful") {
      isolatedWorkspace = await createIsolatedWorkspace(spec.workspaceRoot);
      await copyDelegationContextManifestToIsolatedWorkspace({
        sourceRoot: spec.workspaceRoot,
        isolatedRoot: isolatedWorkspace.root,
        runId: spec.runId,
      });
    }
    childSession = await createHostedSession({
      cwd: isolatedWorkspace?.root ?? spec.workspaceRoot,
      config: spec.config,
      configPath: spec.configPath,
      model: executionPlan.model,
      agentId: buildSubagentAgentId(spec.delegate),
      managedToolMode: executionPlan.managedToolMode,
      enableSubagents: false,
      managedToolNames: executionPlan.managedToolNames,
      builtinToolNames: executionPlan.builtinToolNames,
      logger: hostedSessionLogger,
    });
    childSessionId = asBrewvaSessionId(childSession.session.sessionManager.getSessionId());

    const runningRecord: DelegationRunRecord = {
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ??
        buildDelegationRunRecordSeed({
          runId: spec.runId,
          target: targetRecord,
          delegate: spec.delegate,
          parentSessionId: specParentSessionId,
          createdAt: spec.createdAt,
          label: spec.label,
          taskIdentity: {
            taskName: spec.taskName,
            taskPath: spec.taskPath,
            nickname: spec.nickname,
            depth: spec.depth,
          },
          forkTurns: spec.forkTurns,
          boundary: executionPlan.boundary,
          modelRoute: executionPlan.modelRoute,
          delivery: existing?.delivery,
        })),
      status: "running",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      kind: targetRecord.resultMode,
      consultKind: targetRecord.consultKind,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
    };
    parentRuntime.extensions.hosted.events.record({
      sessionId: spec.parentSessionId,
      type: SUBAGENT_RUNNING_EVENT_TYPE,
      payload: buildDelegationLifecyclePayload(runningRecord),
    });
    ensureDelegationLineageNode({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      record: runningRecord,
    });
    writeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId, {
      schema: "brewva.subagent-run-live.v1",
      runId: spec.runId,
      parentSessionId: specParentSessionId,
      delegate: spec.delegate,
      pid: process.pid,
      createdAt: spec.createdAt,
      updatedAt: Date.now(),
      status: "running",
      label: spec.label,
      workerSessionId: childSessionId,
    });
    if (cancellationReason) {
      throw new Error(cancellationReason);
    }

    if (typeof spec.timeoutMs === "number" && spec.timeoutMs > 0) {
      const timeout = setTimeout(() => {
        timeoutTriggered = true;
        void childSession?.session.abort?.();
      }, spec.timeoutMs);
      timeout.unref?.();
    }

    const preparedEntry = prepareSubagentEntry({
      parentRuntime,
      childRuntime: childSession.runtime,
      childSessionId,
      target: targetRecord,
      delegate: spec.delegate,
      packet,
      promptOverride: executionPlan.prompt,
      inheritedContext: renderInheritedSubagentContext({
        runtime: parentRuntime,
        sessionId: spec.parentSessionId,
        forkTurns: spec.forkTurns,
      }),
    });
    const { delegatedSkill, childOwnsSkill, prompt } = preparedEntry;
    const output = await runHostedTurnEnvelope({
      session: childSession.session,
      prompt,
      runtime: childSession.runtime,
      sessionId: childSessionId,
      source: "subagent",
    });
    if (output.status !== "completed") {
      throw new Error(`subagent_thread_loop_${output.status}`);
    }
    const childCostSummary = childSession.runtime.inspect.cost.summary.get(childSessionId);
    aggregateChildCost(parentRuntime, spec.parentSessionId, childCostSummary);
    const structuredOutcome = extractStructuredOutcomeData({
      resultMode: targetRecord.resultMode,
      consultKind: targetRecord.consultKind,
      assistantText: output.assistantText,
      skillName: childOwnsSkill ? delegatedSkill : undefined,
    });
    if (structuredOutcome.parseError) {
      parentRuntime.extensions.hosted.events.record({
        sessionId: spec.parentSessionId,
        type: "subagent_outcome_parse_failed",
        payload: {
          runId: spec.runId,
          delegate: spec.delegate,
          label: spec.label ?? null,
          kind: targetRecord.resultMode,
          consultKind: targetRecord.consultKind ?? null,
          childSessionId,
          error: structuredOutcome.parseError,
        },
      });
    }
    const structuredSummary = structuredOutcome.data
      ? summarizeStructuredOutcomeData(structuredOutcome.data)
      : undefined;

    const summary = resolveRunSummary(
      structuredOutcome.narrativeText || output.assistantText,
      structuredSummary ??
        `Delegated ${targetRecord.resultMode} run completed without a final assistant summary.`,
    );
    const patches = executionPlan.producesPatches
      ? await capturePatchSetFromIsolatedWorkspace({
          sourceRoot: spec.workspaceRoot,
          isolatedRoot: isolatedWorkspace?.root ?? spec.workspaceRoot,
          summary,
          candidatePaths:
            isolatedWorkspace && childSessionId
              ? collectChangedPathsFromIsolatedWorkspace({
                  isolatedRoot: isolatedWorkspace.root,
                  childSessionId,
                })
              : undefined,
        })
      : undefined;

    if (executionPlan.producesPatches) {
      parentRuntime.authority.session.workerResults.record(
        spec.parentSessionId,
        buildWorkerResult({
          workerId: spec.runId,
          summary,
          patches,
        }),
      );
    }

    const outcomeArtifactRef = buildOutcomeArtifactRef(spec.workspaceRoot, spec.runId);
    const outcome: SubagentOutcome = {
      ok: true,
      runId: spec.runId,
      agent: targetRecord.agent,
      taskName: spec.taskName,
      taskPath: spec.taskPath,
      nickname: spec.nickname,
      delegate: spec.delegate,
      agentSpec: targetRecord.agentSpecName,
      envelope: targetRecord.envelopeName,
      skillName: delegatedSkill,
      consultKind: targetRecord.consultKind,
      label: spec.label,
      kind: targetRecord.resultMode,
      status: "ok",
      workerSessionId: childSessionId,
      summary,
      assistantText: output.assistantText.trim(),
      data: structuredOutcome.data,
      metrics: {
        durationMs: Math.max(0, Date.now() - startedAt),
        inputTokens: childCostSummary.inputTokens,
        outputTokens: childCostSummary.outputTokens,
        totalTokens: childCostSummary.totalTokens,
        costUsd: childCostSummary.totalCostUsd,
      },
      patches,
      artifactRefs: [...(buildPatchArtifactRefs(patches) ?? []), outcomeArtifactRef],
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
    const delivery = applyDurableDelivery({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      delegate: spec.delegate,
      outcome,
      delivery: spec.delivery,
    });
    const resultData = outcome.data
      ? (structuredClone(outcome.data) as unknown as DelegationRunRecord["resultData"])
      : undefined;
    const completedRecord: DelegationRunRecord = {
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ??
        buildDelegationRunRecordSeed({
          runId: spec.runId,
          target: targetRecord,
          delegate: spec.delegate,
          delegatedSkillName: delegatedSkill,
          parentSessionId: specParentSessionId,
          createdAt: spec.createdAt,
          taskIdentity: {
            taskName: spec.taskName,
            taskPath: spec.taskPath,
            nickname: spec.nickname,
            depth: spec.depth,
          },
          forkTurns: spec.forkTurns,
        })),
      status: "completed",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      kind: targetRecord.resultMode,
      consultKind: targetRecord.consultKind,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
      adoption: buildCompletedDelegationAdoption({
        target: targetRecord,
        resultData,
        patchChangeCount: patches?.changes.length,
      }),
      summary,
      resultData,
      artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
      totalTokens: childCostSummary.totalTokens,
      costUsd: childCostSummary.totalCostUsd,
      delivery,
    };
    parentRuntime.extensions.hosted.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_completed",
      payload: buildDelegationLifecyclePayload(completedRecord),
    });
    recordDelegationLineageOutcome({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      record: completedRecord,
    });
    writeDetachedSubagentOutcome(spec.workspaceRoot, spec.runId, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const patches = executionPlan.producesPatches
      ? await capturePatchSetFromIsolatedWorkspace({
          sourceRoot: spec.workspaceRoot,
          isolatedRoot: isolatedWorkspace?.root ?? spec.workspaceRoot,
          summary: message,
          candidatePaths:
            isolatedWorkspace && childSessionId
              ? collectChangedPathsFromIsolatedWorkspace({
                  isolatedRoot: isolatedWorkspace.root,
                  childSessionId,
                })
              : undefined,
        }).catch(() => undefined)
      : undefined;
    const artifactRefs = [
      ...(buildPatchArtifactRefs(patches) ?? []),
      buildOutcomeArtifactRef(spec.workspaceRoot, spec.runId),
    ];
    const terminalStatus: DelegationRunRecord["status"] = timeoutTriggered
      ? "timeout"
      : cancellationReason
        ? "cancelled"
        : "failed";
    if (executionPlan.producesPatches) {
      parentRuntime.authority.session.workerResults.record(
        spec.parentSessionId,
        buildWorkerResult({
          workerId: spec.runId,
          summary: message,
          patches,
          errorMessage: message,
        }),
      );
    }
    const outcome = buildFailureOutcome({
      runId: spec.runId,
      agent: targetRecord.agent,
      taskName: spec.taskName,
      taskPath: spec.taskPath,
      nickname: spec.nickname,
      delegate: spec.delegate,
      agentSpec: targetRecord.agentSpecName,
      envelope: targetRecord.envelopeName,
      skillName: targetRecord.skillName,
      consultKind: targetRecord.consultKind,
      label: spec.label,
      workerSessionId: childSessionId,
      artifactRefs,
      error: message,
      startedAt,
      status:
        terminalStatus === "cancelled" || terminalStatus === "timeout" ? terminalStatus : "error",
    });
    const delivery = applyDurableDelivery({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      delegate: spec.delegate,
      outcome,
      delivery: spec.delivery,
    });
    const failedRecord: DelegationRunRecord = {
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ??
        buildDelegationRunRecordSeed({
          runId: spec.runId,
          target: targetRecord,
          delegate: spec.delegate,
          parentSessionId: specParentSessionId,
          createdAt: spec.createdAt,
          taskIdentity: {
            taskName: spec.taskName,
            taskPath: spec.taskPath,
            nickname: spec.nickname,
            depth: spec.depth,
          },
          forkTurns: spec.forkTurns,
        })),
      status: terminalStatus,
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      kind: targetRecord.resultMode,
      consultKind: targetRecord.consultKind,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
      adoption: buildCompletedDelegationAdoption({
        target: targetRecord,
        resultData: undefined,
        patchChangeCount: patches?.changes.length,
      }),
      summary: message,
      error: message,
      artifactRefs,
      delivery,
    };
    parentRuntime.extensions.hosted.events.record({
      sessionId: spec.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildDelegationLifecyclePayload(failedRecord),
        reason: cancellationReason ?? null,
      },
    });
    recordDelegationLineageOutcome({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      record: failedRecord,
    });
    writeDetachedSubagentOutcome(spec.workspaceRoot, spec.runId, outcome);
  } finally {
    removeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId);
    removeDetachedSubagentCancelRequest(spec.workspaceRoot, spec.runId);
    try {
      await childSession?.session.abort?.();
    } catch {}
    try {
      if (childSession) {
        recordSessionShutdownIfMissing(childSession.runtime, {
          sessionId: childSession.session.sessionManager.getSessionId(),
          reason: resolveSubagentSessionShutdownReason({
            timeoutTriggered,
            cancellationReason,
            completionReason: "subagent_runner_complete",
          }),
          source: "subagent_runner_main",
        });
        childSession.session.dispose();
      }
    } catch {}
    if (isolatedWorkspace) {
      await isolatedWorkspace.dispose().catch(() => undefined);
    }
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
