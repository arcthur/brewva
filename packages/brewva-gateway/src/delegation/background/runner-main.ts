import { readFile } from "node:fs/promises";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/protocol";
import { SUBAGENT_RUNNING_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import {
  createHostedSession,
  resolveSubagentSessionShutdownReason,
  runHostedTurnEnvelope,
} from "../../hosted/api.js";
import { createHostedRuntimeAdapter } from "../../hosted/api.js";
import type { HostedRuntimeAdapterPort } from "../../hosted/api.js";
import { getRuntimeCostSummary } from "../../hosted/api.js";
import { recordSessionShutdownIfMissing } from "../../utils/runtime.js";
import { readDelegationContextBundleManifest } from "../context-manifest.js";
import { buildDelegationRunRecordSeed } from "../delegation-records.js";
import { HostedDelegationStore } from "../delegation-store.js";
import { prepareSubagentEntry } from "../entry.js";
import { resolveDelegationExecutionPlan } from "../execution-plan.js";
import { buildDelegationLifecyclePayload } from "../lifecycle-payload.js";
import { ensureDelegationLineageNode, recordDelegationLineageOutcome } from "../lineage.js";
import { createDelegationModelRoutingContextFromAgentDir } from "../model-routing.js";
import {
  applyDelegationFinalizationReceipt,
  buildDelegationCompletionSummary,
  buildDelegationFailureFinalizationReceipt,
  buildDelegationFinalizationReceipt,
  type DelegationFinalizationReceipt,
} from "../run-finalization.js";
import { buildDelegationRunPlan } from "../run-plan.js";
import { recordDelegationRuntimeEvent } from "../runtime-events.js";
import { buildSubagentAgentId } from "../shared.js";
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
  type DetachedSubagentRunSpec,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentOutcome,
} from "./protocol.js";

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

function applyDetachedFinalization(input: {
  runtime: HostedRuntimeAdapterPort;
  spec: DetachedSubagentRunSpec;
  receipt: DelegationFinalizationReceipt;
}): void {
  applyDelegationFinalizationReceipt({
    runtime: input.runtime,
    receipt: input.receipt,
    recordLineageOutcome: (record) =>
      recordDelegationLineageOutcome({
        runtime: input.runtime,
        sessionId: input.spec.parentSessionId,
        record,
      }),
  });
  writeDetachedSubagentOutcome(input.spec.workspaceRoot, input.spec.runId, input.receipt.outcome);
}

async function loadSpec(path: string): Promise<DetachedSubagentRunSpec> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const schema =
    typeof raw.schema === "string" ? raw.schema : "missing_detached_subagent_spec_schema";
  if (schema !== "brewva.subagent-run-spec.v8") {
    throw new Error(
      `unsupported_detached_subagent_spec_schema:${schema}:clear_.orchestrator/subagent-runs`,
    );
  }
  if (!isRecord(raw.target)) {
    throw new Error("invalid_detached_subagent_spec:missing_target");
  }
  return {
    ...raw,
    schema: "brewva.subagent-run-spec.v8",
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
  const parentRuntime = createHostedRuntimeAdapter({
    cwd: spec.workspaceRoot,
    config: spec.config,
    configPath: spec.configPath,
  });
  const delegationStore = new HostedDelegationStore(parentRuntime);
  const existing = delegationStore.getRun(spec.parentSessionId, spec.runId);
  const target = spec.target;

  const delegationTarget = target;
  const taskIdentity = {
    taskName: spec.taskName,
    taskPath: spec.taskPath,
    nickname: spec.nickname,
    depth: spec.depth,
  };
  const packet = mergeDelegationPacketWithTargetDefaults(delegationTarget, spec.packet);
  if (!packet) {
    const finishedAt = Date.now();
    const initialRecord =
      existing ??
      buildDelegationRunRecordSeed({
        runId: spec.runId,
        target,
        delegate: spec.delegate,
        parentSessionId: specParentSessionId,
        status: "failed",
        createdAt: spec.createdAt,
        updatedAt: finishedAt,
        label: spec.label,
        taskIdentity,
        forkTurns: spec.forkTurns,
      });
    applyDetachedFinalization({
      runtime: parentRuntime,
      spec,
      receipt: buildDelegationFailureFinalizationReceipt({
        parentSessionId: spec.parentSessionId,
        initialRecord,
        currentRecord: existing,
        target: delegationTarget,
        executionPlan: {
          ...(spec.modelRoute ? { modelRoute: spec.modelRoute } : {}),
          producesPatches: false,
        },
        taskIdentity,
        runId: spec.runId,
        delegate: spec.delegate,
        label: spec.label,
        startedAt: spec.createdAt,
        finishedAt,
        message: "missing_delegation_packet",
        terminalStatus: "failed",
        detached: {
          boundary: initialRecord.boundary,
          delivery: spec.delivery,
        },
      }),
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
  let runPlan: ReturnType<typeof buildDelegationRunPlan> | undefined;

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
      modelRole: executionPlan.modelRole ?? spec.modelRole,
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
    recordDelegationRuntimeEvent({
      runtime: parentRuntime,
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
      completionPredicate: spec.packet.completionPredicate,
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

    const contextManifest = readDelegationContextBundleManifest(spec.workspaceRoot, spec.runId);
    if (!contextManifest || contextManifest.hash !== contextManifest.bundle.hash) {
      throw new Error(`detached_context_bundle_invalid:${spec.runId}`);
    }
    runPlan = buildDelegationRunPlan({
      runId: spec.runId,
      parentSessionId: spec.parentSessionId,
      delegate: spec.delegate,
      packet,
      target: targetRecord,
      executionPlan,
      taskIdentity,
      modelRoute: executionPlan.modelRoute,
      contextBundle: contextManifest.bundle,
      delivery: spec.delivery,
      createdAt: spec.createdAt,
    });
    const plan = runPlan;
    const preparedEntry = prepareSubagentEntry({
      parentRuntime,
      childRuntime: childSession.runtime,
      childSessionId,
      target: plan.target,
      delegate: plan.delegate,
      packet: plan.packet,
      promptOverride: executionPlan.prompt,
      contextBundle: plan.contextBundle,
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
    const childCostSummary = getRuntimeCostSummary(childSession.runtime, childSessionId);
    const completionSummary = buildDelegationCompletionSummary({
      target: targetRecord,
      delegatedSkillName: delegatedSkill,
      childOwnsSkill,
      assistantText: output.assistantText,
    });
    const patches = executionPlan.producesPatches
      ? await capturePatchSetFromIsolatedWorkspace({
          sourceRoot: spec.workspaceRoot,
          isolatedRoot: isolatedWorkspace?.root ?? spec.workspaceRoot,
          summary: completionSummary.summary,
          candidatePaths:
            isolatedWorkspace && childSessionId
              ? collectChangedPathsFromIsolatedWorkspace({
                  isolatedRoot: isolatedWorkspace.root,
                  childSessionId,
                })
              : undefined,
        })
      : undefined;
    const finishedAt = Date.now();
    const finalizationReceipt = buildDelegationFinalizationReceipt({
      parentSessionId: plan.parentSessionId,
      initialRecord: runningRecord,
      currentRecord: delegationStore.getRun(plan.parentSessionId, plan.runId),
      target: plan.target,
      executionPlan: plan.executionPlan,
      taskIdentity: plan.taskIdentity,
      runId: plan.runId,
      delegate: plan.delegate,
      delegatedSkillName: delegatedSkill,
      childOwnsSkill,
      childSessionId,
      label: spec.label,
      startedAt,
      finishedAt,
      assistantText: output.assistantText,
      toolOutputs: output.toolOutputs,
      childCostSummary,
      patches,
      detached: {
        boundary: executionPlan.boundary,
        delivery: spec.delivery,
      },
    });
    applyDetachedFinalization({
      runtime: parentRuntime,
      spec,
      receipt: finalizationReceipt,
    });
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
    const terminalStatus: Extract<
      DelegationRunRecord["status"],
      "failed" | "cancelled" | "timeout"
    > = timeoutTriggered ? "timeout" : cancellationReason ? "cancelled" : "failed";
    const terminalCostSummary =
      childSession && childSessionId
        ? getRuntimeCostSummary(childSession.runtime, childSessionId)
        : undefined;
    const finishedAt = Date.now();
    const failedPlan = runPlan;
    const finalizationReceipt = buildDelegationFailureFinalizationReceipt({
      parentSessionId: failedPlan?.parentSessionId ?? spec.parentSessionId,
      initialRecord:
        delegationStore.getRun(
          failedPlan?.parentSessionId ?? spec.parentSessionId,
          failedPlan?.runId ?? spec.runId,
        ) ??
        buildDelegationRunRecordSeed({
          runId: failedPlan?.runId ?? spec.runId,
          target: failedPlan?.target ?? targetRecord,
          delegate: failedPlan?.delegate ?? spec.delegate,
          parentSessionId: specParentSessionId,
          createdAt: spec.createdAt,
          taskIdentity: failedPlan?.taskIdentity ?? taskIdentity,
          forkTurns: spec.forkTurns,
        }),
      currentRecord: delegationStore.getRun(
        failedPlan?.parentSessionId ?? spec.parentSessionId,
        failedPlan?.runId ?? spec.runId,
      ),
      target: failedPlan?.target ?? targetRecord,
      executionPlan: failedPlan?.executionPlan ?? executionPlan,
      taskIdentity: failedPlan?.taskIdentity ?? taskIdentity,
      runId: failedPlan?.runId ?? spec.runId,
      delegate: failedPlan?.delegate ?? spec.delegate,
      childSessionId,
      label: spec.label,
      startedAt,
      finishedAt,
      message,
      terminalStatus,
      patches,
      terminalCostSummary,
      cancellationReason,
      detached: {
        boundary: executionPlan.boundary,
        delivery: spec.delivery,
      },
    });
    applyDetachedFinalization({
      runtime: parentRuntime,
      spec,
      receipt: finalizationReceipt,
    });
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
