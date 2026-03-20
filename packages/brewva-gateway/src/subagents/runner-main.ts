import { readFile } from "node:fs/promises";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { DelegationRunRecord, SkillRoutingScope } from "@brewva/brewva-runtime";
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
  type DetachedSubagentRunSpec,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentOutcome,
} from "./background-protocol.js";
import {
  loadHostedSubagentProfiles,
  mergeDelegationPacketWithProfileDefaults,
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

function buildFailureOutcome(input: {
  runId: string;
  profile: string;
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
    profile: input.profile,
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
  profile: string;
  outcome: SubagentOutcome;
  delivery: NonNullable<SubagentRunRequest["delivery"]> | undefined;
}): DelegationRunRecord["delivery"] | undefined {
  if (!input.delivery) {
    return undefined;
  }
  const createdAt = Date.now();
  const deliveryRecord: NonNullable<DelegationRunRecord["delivery"]> = {
    mode: input.delivery.returnMode,
    scopeId: input.delivery.returnScopeId,
    label: input.delivery.returnLabel,
    supplementalAppended: false,
    updatedAt: createdAt,
  };
  return deliveryRecord;
}

async function loadSpec(path: string): Promise<DetachedSubagentRunSpec> {
  const raw = JSON.parse(await readFile(path, "utf8")) as DetachedSubagentRunSpec;
  return raw;
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
    configPath: spec.configPath,
    routingScopes: normalizeRoutingScopes(spec.routingScopes),
  });
  const existing = parentRuntime.session.getDelegationRun(spec.parentSessionId, spec.runId);
  const profiles = await loadHostedSubagentProfiles(spec.workspaceRoot);
  const profile = profiles.get(spec.profileName);
  if (!profile) {
    const failed = {
      ...(existing ?? {
        runId: spec.runId,
        profile: spec.profileName,
        parentSessionId: spec.parentSessionId,
        status: "failed" as const,
        createdAt: spec.createdAt,
        updatedAt: Date.now(),
      }),
      status: "failed" as const,
      updatedAt: Date.now(),
      error: `unknown_profile:${spec.profileName}`,
      summary: `unknown_profile:${spec.profileName}`,
    };
    parentRuntime.session.recordDelegationRun(spec.parentSessionId, failed);
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_failed",
      payload: buildLifecyclePayload(failed),
    });
    removeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId);
    process.exitCode = 1;
    return;
  }

  const packet = mergeDelegationPacketWithProfileDefaults(profile, spec.packet);
  if (!packet) {
    const failed = {
      ...(existing ?? {
        runId: spec.runId,
        profile: spec.profileName,
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
    parentRuntime.session.recordDelegationRun(spec.parentSessionId, failed);
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_failed",
      payload: buildLifecyclePayload(failed),
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
  let profileRecord: HostedSubagentProfile = profile;
  const requestedBoundary = resolveRequestedBoundary(profileRecord, packet);

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
    if (requestedBoundary === "effectful") {
      isolatedWorkspace = await createIsolatedWorkspace(spec.workspaceRoot);
    }
    childSession = await createHostedSession({
      cwd: isolatedWorkspace?.root ?? spec.workspaceRoot,
      configPath: spec.configPath,
      model: profileRecord.model,
      agentId: `subagent-${sanitizeFragment(profileRecord.name) || "worker"}`,
      enableExtensions: profileRecord.enableExtensions ?? false,
      enableSubagents: false,
      managedToolNames: resolveManagedToolNamesForRun(
        parentRuntime,
        profileRecord,
        requestedBoundary,
      ),
      builtinToolNames: resolveBuiltinToolNamesForRun(
        parentRuntime,
        profileRecord,
        requestedBoundary,
      ),
      routingScopes: normalizeRoutingScopes(spec.routingScopes),
    });
    childSessionId = childSession.session.sessionManager.getSessionId();

    const runningRecord: DelegationRunRecord = {
      ...(parentRuntime.session.getDelegationRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        profile: spec.profileName,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
        label: spec.label,
        parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
        kind: profileRecord.resultMode,
        boundary: requestedBoundary,
        delivery: existing?.delivery,
      }),
      status: "running",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      kind: profileRecord.resultMode,
      boundary: requestedBoundary,
    };
    parentRuntime.session.recordDelegationRun(spec.parentSessionId, runningRecord);
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_spawned",
      payload: buildLifecyclePayload(runningRecord),
    });
    writeDetachedSubagentLiveState(spec.workspaceRoot, spec.runId, {
      schema: "brewva.subagent-run-live.v1",
      runId: spec.runId,
      parentSessionId: spec.parentSessionId,
      profile: spec.profileName,
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

    const activationSkill = packet.entrySkill ?? profileRecord.entrySkill;
    if (activationSkill) {
      const activation = childSession.runtime.skills.activate(childSessionId, activationSkill);
      if (!activation.ok) {
        throw new Error(`subagent_entry_skill_failed:${activation.reason}`);
      }
    }

    const prompt = buildDelegationPrompt(profileRecord, packet);
    const output = await collectSessionPromptOutput(childSession.session, prompt);
    const childCostSummary = childSession.runtime.cost.getSummary(childSessionId);
    aggregateChildCost(parentRuntime, spec.parentSessionId, childCostSummary);

    const summary = resolveRunSummary(
      output.assistantText,
      `Delegated ${profileRecord.resultMode} run completed without a final assistant summary.`,
    );
    const patches = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: spec.workspaceRoot,
      isolatedRoot: isolatedWorkspace?.root ?? spec.workspaceRoot,
      summary,
    });

    if (requestedBoundary === "effectful") {
      parentRuntime.session.recordWorkerResult(
        spec.parentSessionId,
        buildWorkerResult({
          workerId: spec.runId,
          summary,
          patches,
        }),
      );
    }

    const outcome: SubagentOutcome = {
      ok: true,
      runId: spec.runId,
      profile: spec.profileName,
      label: spec.label,
      kind: profileRecord.resultMode,
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
    const delivery = applyDurableDelivery({
      runtime: parentRuntime,
      sessionId: spec.parentSessionId,
      profile: spec.profileName,
      outcome,
      delivery: spec.delivery,
    });
    const completedRecord: DelegationRunRecord = {
      ...(parentRuntime.session.getDelegationRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        profile: spec.profileName,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
      }),
      status: "completed",
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
      kind: profileRecord.resultMode,
      boundary: requestedBoundary,
      summary,
      artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
      totalTokens: childCostSummary.totalTokens,
      costUsd: childCostSummary.totalCostUsd,
      delivery,
    };
    parentRuntime.session.recordDelegationRun(spec.parentSessionId, completedRecord);
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: "subagent_completed",
      payload: buildLifecyclePayload(completedRecord),
    });
    writeDetachedSubagentOutcome(spec.workspaceRoot, spec.runId, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const patches = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: spec.workspaceRoot,
      isolatedRoot: isolatedWorkspace?.root ?? spec.workspaceRoot,
      summary: message,
    }).catch(() => undefined);
    const artifactRefs = buildPatchArtifactRefs(patches);
    const terminalStatus: DelegationRunRecord["status"] = timeoutTriggered
      ? "timeout"
      : cancellationReason
        ? "cancelled"
        : "failed";
    if (requestedBoundary === "effectful") {
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
      profile: spec.profileName,
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
      profile: spec.profileName,
      outcome,
      delivery: spec.delivery,
    });
    const failedRecord: DelegationRunRecord = {
      ...(parentRuntime.session.getDelegationRun(spec.parentSessionId, spec.runId) ?? {
        runId: spec.runId,
        profile: spec.profileName,
        parentSessionId: spec.parentSessionId,
        createdAt: spec.createdAt,
      }),
      status: terminalStatus,
      updatedAt: Date.now(),
      workerSessionId: childSessionId,
      label: spec.label,
      parentSkill: parentRuntime.skills.getActive(spec.parentSessionId)?.name,
      kind: profileRecord.resultMode,
      boundary: requestedBoundary,
      summary: message,
      error: message,
      artifactRefs,
      delivery,
    };
    parentRuntime.session.recordDelegationRun(spec.parentSessionId, failedRecord);
    parentRuntime.events.record({
      sessionId: spec.parentSessionId,
      type: terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      payload: {
        ...buildLifecyclePayload(failedRecord),
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
