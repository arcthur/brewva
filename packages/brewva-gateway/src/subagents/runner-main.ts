import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  SUBAGENT_RUNNING_EVENT_TYPE,
  type DelegationRunRecord,
  type SkillRoutingScope,
} from "@brewva/brewva-runtime";
import type {
  SubagentOutcome,
  SubagentOutcomeArtifactRef,
  SubagentRunRequest,
} from "@brewva/brewva-tools";
import { createHostedSession } from "../host/create-hosted-session.js";
import { collectSessionPromptOutput } from "../session/collect-output.js";
import {
  readDetachedSubagentCancelRequest,
  removeDetachedSubagentCancelRequest,
  removeDetachedSubagentLiveState,
  resolveDetachedSubagentOutcomePath,
  type DetachedSubagentRunSpec,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentOutcome,
} from "./background-protocol.js";
import { HostedDelegationStore, buildDelegationLifecyclePayload } from "./delegation-store.js";
import { createDelegationModelRoutingContextFromAgentDir } from "./model-routing.js";
import { buildDelegationPrompt } from "./prompt.js";
import {
  aggregateChildCost,
  buildPatchArtifactRefs,
  buildWorkerResult,
  formatSkillValidationError,
  resolveDelegationExecutionPlan,
  resolveRunSummary,
  sanitizeFragment,
} from "./shared.js";
import {
  extractStructuredOutcomeData,
  summarizeStructuredOutcomeData,
} from "./structured-outcome.js";
import { mergeDelegationPacketWithTargetDefaults, type HostedDelegationTarget } from "./targets.js";
import {
  capturePatchSetFromIsolatedWorkspace,
  collectChangedPathsFromIsolatedWorkspace,
  copyDelegationContextManifestToIsolatedWorkspace,
  createIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

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
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
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
    delegate: input.delegate,
    agentSpec: input.agentSpec,
    envelope: input.envelope,
    skillName: input.skillName,
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
  runtime: BrewvaRuntime;
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
  if (schema !== "brewva.subagent-run-spec.v6") {
    throw new Error(`unsupported_detached_subagent_spec_schema:${schema}`);
  }
  return {
    ...raw,
    schema: "brewva.subagent-run-spec.v6",
  } as unknown as DetachedSubagentRunSpec;
}

function normalizeRoutingScopes(
  scopes: SkillRoutingScope[] | undefined,
): SkillRoutingScope[] | undefined {
  if (!scopes || scopes.length === 0) {
    return undefined;
  }
  return [...new Set(scopes)];
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    process.exitCode = 1;
    return;
  }

  const spec = await loadSpec(specPath);
  const parentRuntime = new BrewvaRuntime({
    cwd: spec.workspaceRoot,
    config: spec.config,
    configPath: spec.configPath,
    routingScopes: normalizeRoutingScopes(spec.routingScopes),
  });
  const delegationStore = new HostedDelegationStore(parentRuntime);
  const existing = delegationStore.getRun(spec.parentSessionId, spec.runId);
  const target = spec.target;
  if (!target) {
    const failed = {
      ...(existing ?? {
        runId: spec.runId,
        delegate: spec.delegate,
        parentSessionId: spec.parentSessionId,
        status: "failed" as const,
        createdAt: spec.createdAt,
        updatedAt: Date.now(),
      }),
      status: "failed" as const,
      updatedAt: Date.now(),
      error: `missing_delegate_target:${spec.delegate}`,
      summary: `missing_delegate_target:${spec.delegate}`,
    };
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_failed",
      payload: buildDelegationLifecyclePayload(failed),
    });
    removeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId);
    process.exitCode = 1;
    return;
  }

  const delegationTarget = target;
  const packet = mergeDelegationPacketWithTargetDefaults(delegationTarget, spec.packet);
  if (!packet) {
    const failed = {
      ...(existing ?? {
        runId: spec.runId,
        delegate: spec.delegate,
        parentSessionId: spec.parentSessionId,
        status: "failed" as const,
        createdAt: spec.createdAt,
        updatedAt: Date.now(),
      }),
      status: "failed" as const,
      updatedAt: Date.now(),
      error: "missing_delegation_packet",
      summary: "missing_delegation_packet",
    };
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_failed",
      payload: buildDelegationLifecyclePayload(failed),
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
  let childSessionId: string | undefined;
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
      agentId: `subagent-${sanitizeFragment(spec.delegate) || "worker"}`,
      managedToolMode: executionPlan.managedToolMode,
      enableSubagents: false,
      managedToolNames: executionPlan.managedToolNames,
      builtinToolNames: executionPlan.builtinToolNames,
      contextProfile: executionPlan.contextProfile,
      routingScopes: normalizeRoutingScopes(spec.routingScopes),
    });
    childSessionId = childSession.session.sessionManager.getSessionId();

    const runningRecord: DelegationRunRecord = {
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        delegate: spec.delegate,
        agentSpec: targetRecord.agentSpecName,
        envelope: targetRecord.envelopeName,
        skillName: targetRecord.skillName,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
        label: spec.label,
        parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
        kind: targetRecord.resultMode,
        boundary: executionPlan.boundary,
        modelRoute: executionPlan.modelRoute,
        delivery: existing?.delivery,
      }),
      status: "running",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      kind: targetRecord.resultMode,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
    };
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: SUBAGENT_RUNNING_EVENT_TYPE,
      payload: buildDelegationLifecyclePayload(runningRecord),
    });
    writeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId, {
      schema: "brewva.subagent-run-live.v1",
      runId: spec.runId,
      parentSessionId: spec.parentSessionId,
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

    const delegatedSkill = targetRecord.skillName;
    const skillDocument = delegatedSkill ? parentRuntime.skills.get(delegatedSkill) : undefined;
    if (delegatedSkill && !skillDocument) {
      throw new Error(`unknown_skill:${delegatedSkill}`);
    }
    if (delegatedSkill) {
      const activation = childSession.runtime.skills.activate(childSessionId, delegatedSkill);
      if (!activation.ok) {
        throw new Error(`subagent_entry_skill_failed:${activation.reason}`);
      }
    }

    const prompt = buildDelegationPrompt({
      target: targetRecord,
      delegate: spec.delegate,
      packet,
      promptOverride: executionPlan.prompt,
      skill: skillDocument,
    });
    const output = await collectSessionPromptOutput(childSession.session, prompt, {
      runtime: childSession.runtime,
      sessionId: childSessionId,
    });
    const childCostSummary = childSession.runtime.cost.getSummary(childSessionId);
    aggregateChildCost(parentRuntime, spec.parentSessionId, childCostSummary);
    const structuredOutcome = extractStructuredOutcomeData({
      resultMode: targetRecord.resultMode,
      assistantText: output.assistantText,
      skillName: delegatedSkill,
    });
    if (structuredOutcome.parseError) {
      parentRuntime.events.record({
        sessionId: spec.parentSessionId,
        type: "subagent_outcome_parse_failed",
        payload: {
          runId: spec.runId,
          delegate: spec.delegate,
          label: spec.label ?? null,
          kind: targetRecord.resultMode,
          childSessionId,
          error: structuredOutcome.parseError,
        },
      });
    }
    const skillValidation =
      delegatedSkill && childSessionId
        ? childSession.runtime.skills.validateOutputs(
            childSessionId,
            structuredOutcome.skillOutputs ?? {},
          )
        : undefined;
    if (delegatedSkill && skillValidation && !skillValidation.ok) {
      parentRuntime.events.record({
        sessionId: spec.parentSessionId,
        type: "subagent_skill_output_validation_failed",
        payload: {
          runId: spec.runId,
          delegate: spec.delegate,
          label: spec.label ?? null,
          kind: targetRecord.resultMode,
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
      parentRuntime.session.recordWorkerResult(
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
      delegate: spec.delegate,
      agentSpec: targetRecord.agentSpecName,
      envelope: targetRecord.envelopeName,
      skillName: delegatedSkill,
      label: spec.label,
      kind: targetRecord.resultMode,
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
    const completedRecord: DelegationRunRecord = {
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        delegate: spec.delegate,
        agentSpec: targetRecord.agentSpecName,
        envelope: targetRecord.envelopeName,
        skillName: delegatedSkill,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
      }),
      status: "completed",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
      kind: targetRecord.resultMode,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
      summary,
      resultData: outcome.data
        ? (structuredClone(outcome.data) as unknown as DelegationRunRecord["resultData"])
        : undefined,
      artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
      totalTokens: childCostSummary.totalTokens,
      costUsd: childCostSummary.totalCostUsd,
      delivery,
    };
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_completed",
      payload: buildDelegationLifecyclePayload(completedRecord),
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
      parentRuntime.session.recordWorkerResult(
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
      delegate: spec.delegate,
      agentSpec: targetRecord.agentSpecName,
      envelope: targetRecord.envelopeName,
      skillName: targetRecord.skillName,
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
      ...(delegationStore.getRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        delegate: spec.delegate,
        agentSpec: targetRecord.agentSpecName,
        envelope: targetRecord.envelopeName,
        skillName: targetRecord.skillName,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
      }),
      status: terminalStatus,
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
      kind: targetRecord.resultMode,
      boundary: executionPlan.boundary,
      modelRoute: executionPlan.modelRoute,
      summary: message,
      error: message,
      artifactRefs,
      delivery,
    };
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildDelegationLifecyclePayload(failedRecord),
        reason: cancellationReason ?? null,
      },
    });
    writeDetachedSubagentOutcome(spec.workspaceRoot, spec.runId, outcome);
  } finally {
    removeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId);
    removeDetachedSubagentCancelRequest(spec.workspaceRoot, spec.runId);
    try {
      await childSession?.session.abort?.();
    } catch {
      // best effort abort
    }
    try {
      childSession?.session.dispose();
    } catch {
      // best effort dispose
    }
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
