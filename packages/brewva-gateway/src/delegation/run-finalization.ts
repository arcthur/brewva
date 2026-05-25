import type {
  SubagentOutcome,
  SubagentOutcomeArtifactRef,
  SubagentOutcomeSuccess,
  SubagentRunRequest,
} from "@brewva/brewva-tools/contracts";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import type { WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type { SessionCostSummary } from "@brewva/brewva-vocabulary/session";
import type { ToolOutputView } from "@brewva/brewva-vocabulary/wire";
import type { PatchSet } from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import { recordRuntimeAssistantCost, recordRuntimeWorkerResult } from "../hosted/api.js";
import {
  buildCompletedDelegationAdoption,
  resolveDelegationRecordIdentity,
  type DelegationTaskIdentity,
} from "./delegation-records.js";
import type { ResolvedDelegationExecutionPlan } from "./execution-plan.js";
import { buildDelegationLifecyclePayload } from "./lifecycle-payload.js";
import { recordDelegationRuntimeEvent } from "./runtime-events.js";
import {
  extractStructuredOutcomeData,
  summarizeStructuredOutcomeData,
} from "./structured-outcome.js";
import type { HostedDelegationTarget } from "./targets.js";

const PATCH_MANIFEST_FILE_NAME = "patchset.json";

function summarizeAssistantText(text: string): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= 360) {
    return normalized;
  }
  return `${normalized.slice(0, 357)}...`;
}

export function resolveRunSummary(text: string, fallback: string): string {
  const summary = summarizeAssistantText(text);
  return summary || fallback;
}

export function aggregateChildCost(
  runtime: HostedRuntimeAdapterPort,
  parentSessionId: string,
  childSummary: SessionCostSummary,
): void {
  for (const [model, totals] of Object.entries(childSummary.models)) {
    if (totals.totalTokens <= 0 && totals.totalCostUsd <= 0) {
      continue;
    }
    recordRuntimeAssistantCost(runtime, {
      sessionId: parentSessionId,
      model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.totalTokens,
      costUsd: totals.totalCostUsd,
      stopReason: "subagent_run",
    });
  }
}

export function buildWorkerResult(input: {
  workerId: string;
  summary: string;
  patches?: PatchSet;
  errorMessage?: string;
}): WorkerResult {
  if (input.errorMessage) {
    return {
      workerId: input.workerId,
      status: "error",
      summary: input.summary,
      patches: input.patches,
      errorMessage: input.errorMessage,
    };
  }

  if (!input.patches) {
    return {
      workerId: input.workerId,
      status: "skipped",
      summary: input.summary,
    };
  }

  return {
    workerId: input.workerId,
    status: "ok",
    summary: input.summary,
    patches: input.patches,
  };
}

export function buildPatchArtifactRefs(
  patches: PatchSet | undefined,
): SubagentOutcomeArtifactRef[] | undefined {
  if (!patches) {
    return undefined;
  }
  const refs: SubagentOutcomeArtifactRef[] = [
    {
      kind: "patch_manifest",
      path: `.orchestrator/subagent-patch-artifacts/${patches.id}/${PATCH_MANIFEST_FILE_NAME}`,
      summary: `Patch manifest for ${patches.id}`,
    },
    ...patches.changes
      .filter((change) => typeof change.artifactRef === "string" && change.artifactRef.length > 0)
      .map((change) => ({
        kind: "patch_file",
        path: change.artifactRef!,
        summary: `${change.action} ${change.path}`,
      })),
  ];
  return refs;
}

export interface DelegationFinalizationReceipt {
  runId: string;
  parentSessionId: string;
  outcome: SubagentOutcome;
  record: DelegationRunRecord;
  lifecycleEvent: {
    type: "subagent_completed" | "subagent_cancelled" | "subagent_failed";
    payload: Record<string, unknown>;
  };
  parseFailureEvent?: {
    type: "subagent_outcome_parse_failed";
    payload: Record<string, unknown>;
  };
  workerResult?: WorkerResult;
  costRollup?: SessionCostSummary;
  lineageOutcome: DelegationRunRecord;
  adoptLineageOutcome: boolean;
  slotReleaseIntent: "worker_result_recorded" | "release_in_finally";
}

interface DetachedDelegationFinalizationInput {
  boundary: DelegationRunRecord["boundary"];
  delivery?: NonNullable<SubagentRunRequest["delivery"]>;
}

function buildDetachedOutcomeArtifactRef(runId: string): SubagentOutcomeArtifactRef {
  return {
    kind: "delegation_outcome",
    path: `.orchestrator/subagent-runs/${runId}/outcome.json`,
    summary: `Detached delegation outcome for ${runId}`,
  };
}

function buildDetachedDeliveryRecord(
  delivery: NonNullable<SubagentRunRequest["delivery"]> | undefined,
  timestamp: number,
): NonNullable<DelegationRunRecord["delivery"]> {
  return {
    mode: delivery?.returnMode ?? "text_only",
    scopeId: delivery?.returnScopeId,
    label: delivery?.returnLabel,
    handoffState: "pending_parent_turn",
    readyAt: timestamp,
    supplementalAppended: false,
    updatedAt: timestamp,
  };
}

function applyDetachedFinalizationMetadata(input: {
  outcome: SubagentOutcome;
  record: DelegationRunRecord;
  runId: string;
  target: Pick<HostedDelegationTarget, "resultMode" | "consultKind">;
  label?: string;
  finishedAt: number;
  detached?: DetachedDelegationFinalizationInput;
}): { outcome: SubagentOutcome; record: DelegationRunRecord } {
  if (!input.detached) {
    return { outcome: input.outcome, record: input.record };
  }

  const outcomeArtifactRef = buildDetachedOutcomeArtifactRef(input.runId);
  const outcome: SubagentOutcome = {
    ...input.outcome,
    artifactRefs: [...(input.outcome.artifactRefs ?? []), outcomeArtifactRef],
  };
  return {
    outcome,
    record: {
      ...input.record,
      label: input.label,
      kind: input.target.resultMode,
      consultKind: input.target.consultKind,
      boundary: input.detached.boundary ?? input.record.boundary,
      artifactRefs: outcome.artifactRefs?.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        summary: ref.summary,
      })),
      delivery: buildDetachedDeliveryRecord(input.detached.delivery, input.finishedAt),
    },
  };
}

function buildTerminalLifecycleEvent(input: {
  type: DelegationFinalizationReceipt["lifecycleEvent"]["type"];
  record: DelegationRunRecord;
  terminalPayload: Record<string, unknown>;
}): DelegationFinalizationReceipt["lifecycleEvent"] {
  return {
    type: input.type,
    payload: {
      ...buildDelegationLifecyclePayload(input.record),
      ...input.terminalPayload,
    },
  };
}

function extractTerminalLifecyclePayload(
  receipt: DelegationFinalizationReceipt,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if ("reason" in receipt.lifecycleEvent.payload) {
    payload.reason = receipt.lifecycleEvent.payload.reason;
  }
  if ("workerStatus" in receipt.lifecycleEvent.payload) {
    payload.workerStatus = receipt.lifecycleEvent.payload.workerStatus;
  }
  if ("patchChangeCount" in receipt.lifecycleEvent.payload) {
    payload.patchChangeCount = receipt.lifecycleEvent.payload.patchChangeCount;
  }
  return payload;
}

export function rebuildDelegationFinalizationLifecycleEvent(
  receipt: DelegationFinalizationReceipt,
): DelegationFinalizationReceipt {
  return {
    ...receipt,
    lifecycleEvent: buildTerminalLifecycleEvent({
      type: receipt.lifecycleEvent.type,
      record: receipt.record,
      terminalPayload: extractTerminalLifecyclePayload(receipt),
    }),
  };
}

export function buildDelegationCompletionSummary(input: {
  target: HostedDelegationTarget;
  delegatedSkillName?: string;
  childOwnsSkill?: boolean;
  assistantText: string;
}): {
  structuredOutcome: ReturnType<typeof extractStructuredOutcomeData>;
  summary: string;
} {
  const structuredOutcome = extractStructuredOutcomeData({
    resultMode: input.target.resultMode,
    consultKind: input.target.consultKind,
    assistantText: input.assistantText,
    skillName: input.childOwnsSkill ? input.delegatedSkillName : undefined,
  });
  const fallbackSummary =
    structuredOutcome.data && summarizeStructuredOutcomeData(structuredOutcome.data)
      ? summarizeStructuredOutcomeData(structuredOutcome.data)!
      : `Delegated ${input.target.resultMode} run completed without a final assistant summary.`;
  return {
    structuredOutcome,
    summary: resolveRunSummary(
      structuredOutcome.narrativeText || input.assistantText,
      fallbackSummary,
    ),
  };
}

export function buildDelegationFailureOutcome(input: {
  target: HostedDelegationTarget;
  taskIdentity: DelegationTaskIdentity;
  runId: string;
  delegate: string;
  label?: string;
  childSessionId?: DelegationRunRecord["workerSessionId"];
  message: string;
  status: "error" | "cancelled" | "timeout";
  startedAt: number;
  finishedAt: number;
  artifactRefs?: SubagentOutcomeArtifactRef[];
}): SubagentOutcome {
  return {
    ok: false,
    runId: input.runId,
    agent: input.target.agent,
    taskName: input.taskIdentity.taskName,
    taskPath: input.taskIdentity.taskPath,
    nickname: input.taskIdentity.nickname,
    delegate: input.delegate,
    agentSpec: input.target.agentSpecName,
    envelope: input.target.envelopeName,
    skillName: input.target.skillName,
    consultKind: input.target.consultKind,
    label: input.label,
    status: input.status,
    workerSessionId: input.childSessionId,
    error: input.message,
    metrics: {
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
    },
    artifactRefs: input.artifactRefs,
  };
}

export function buildDelegationFinalizationReceipt(input: {
  parentSessionId: string;
  initialRecord: DelegationRunRecord;
  currentRecord?: DelegationRunRecord;
  target: HostedDelegationTarget;
  executionPlan: Pick<ResolvedDelegationExecutionPlan, "modelRoute" | "producesPatches">;
  taskIdentity: DelegationTaskIdentity;
  runId: string;
  delegate: string;
  delegatedSkillName?: string;
  childOwnsSkill?: boolean;
  childSessionId?: DelegationRunRecord["workerSessionId"];
  label?: string;
  startedAt: number;
  finishedAt: number;
  assistantText: string;
  toolOutputs: readonly ToolOutputView[];
  childCostSummary: SessionCostSummary;
  patches?: PatchSet;
  delivery?: DelegationRunRecord["delivery"];
  supplementalDeliveryAppended?: boolean;
  detached?: DetachedDelegationFinalizationInput;
}): DelegationFinalizationReceipt {
  const { structuredOutcome, summary } = buildDelegationCompletionSummary({
    target: input.target,
    delegatedSkillName: input.delegatedSkillName,
    childOwnsSkill: input.childOwnsSkill,
    assistantText: input.assistantText,
  });
  const workerResult = input.executionPlan.producesPatches
    ? buildWorkerResult({
        workerId: input.runId,
        summary,
        patches: input.patches,
      })
    : undefined;
  const artifactRefs = buildPatchArtifactRefs(input.patches);
  const outcome: SubagentOutcomeSuccess = {
    ok: true,
    runId: input.runId,
    agent: input.target.agent,
    taskName: input.taskIdentity.taskName,
    taskPath: input.taskIdentity.taskPath,
    nickname: input.taskIdentity.nickname,
    delegate: input.delegate,
    agentSpec: input.target.agentSpecName,
    envelope: input.target.envelopeName,
    skillName: input.delegatedSkillName,
    consultKind: input.target.consultKind,
    label: input.label,
    kind: input.target.resultMode,
    status: "ok",
    workerSessionId: input.childSessionId,
    summary,
    assistantText: input.assistantText.trim(),
    data: structuredOutcome.data,
    metrics: {
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
      inputTokens: input.childCostSummary.inputTokens,
      outputTokens: input.childCostSummary.outputTokens,
      totalTokens: input.childCostSummary.totalTokens,
      costUsd: input.childCostSummary.totalCostUsd,
    },
    patches: input.patches,
    artifactRefs,
    evidenceRefs: [
      ...(input.childSessionId
        ? [
            {
              kind: "event" as const,
              locator: `session:${input.childSessionId}:agent_end`,
              summary: "Child run completed",
              sourceSessionId: input.childSessionId,
            },
          ]
        : []),
      ...input.toolOutputs.slice(0, 8).map((toolOutput) => ({
        kind: "tool_result" as const,
        locator: `session:${input.childSessionId}:tool:${toolOutput.toolCallId}`,
        summary: `${toolOutput.toolName}:${toolOutput.verdict}`,
        sourceSessionId: input.childSessionId,
      })),
    ],
  };
  const resultData = outcome.data
    ? (structuredClone(outcome.data) as unknown as DelegationRunRecord["resultData"])
    : undefined;
  const baseRecord: DelegationRunRecord = {
    ...(input.currentRecord ?? input.initialRecord),
    ...resolveDelegationRecordIdentity({
      target: input.target,
      delegatedSkillName: input.delegatedSkillName,
    }),
    status: "completed",
    updatedAt: input.finishedAt,
    workerSessionId: input.childSessionId,
    modelRoute: input.executionPlan.modelRoute,
    adoption: buildCompletedDelegationAdoption({
      target: input.target,
      resultData,
      patchChangeCount: input.patches?.changes.length,
    }),
    summary,
    error: undefined,
    resultData,
    artifactRefs: outcome.artifactRefs?.map((ref) => ({ ...ref })),
    delivery: input.delivery,
    totalTokens: input.childCostSummary.totalTokens,
    costUsd: input.childCostSummary.totalCostUsd,
  };
  const { outcome: finalOutcome, record } = applyDetachedFinalizationMetadata({
    outcome,
    record: baseRecord,
    runId: input.runId,
    target: input.target,
    label: input.label,
    finishedAt: input.finishedAt,
    detached: input.detached,
  });
  return {
    runId: input.runId,
    parentSessionId: input.parentSessionId,
    outcome: finalOutcome,
    record,
    lifecycleEvent: buildTerminalLifecycleEvent({
      type: "subagent_completed",
      record,
      terminalPayload: {
        workerStatus: workerResult?.status ?? null,
        patchChangeCount: input.patches?.changes.length ?? 0,
      },
    }),
    parseFailureEvent: structuredOutcome.parseError
      ? {
          type: "subagent_outcome_parse_failed",
          payload: {
            runId: input.runId,
            delegate: input.delegate,
            label: input.label ?? null,
            kind: input.target.resultMode,
            consultKind: input.target.consultKind ?? null,
            childSessionId: input.childSessionId,
            error: structuredOutcome.parseError,
          },
        }
      : undefined,
    workerResult,
    costRollup: input.childCostSummary,
    lineageOutcome: record,
    adoptLineageOutcome: input.supplementalDeliveryAppended === true,
    slotReleaseIntent: workerResult ? "worker_result_recorded" : "release_in_finally",
  };
}

export function buildDelegationFailureFinalizationReceipt(input: {
  parentSessionId: string;
  initialRecord: DelegationRunRecord;
  currentRecord?: DelegationRunRecord;
  target: HostedDelegationTarget;
  executionPlan: Pick<ResolvedDelegationExecutionPlan, "modelRoute" | "producesPatches">;
  taskIdentity: DelegationTaskIdentity;
  runId: string;
  delegate: string;
  childSessionId?: DelegationRunRecord["workerSessionId"];
  label?: string;
  startedAt: number;
  finishedAt: number;
  message: string;
  terminalStatus: Extract<DelegationRunRecord["status"], "failed" | "cancelled" | "timeout">;
  patches?: PatchSet;
  delivery?: DelegationRunRecord["delivery"];
  terminalCostSummary?: SessionCostSummary;
  cancellationReason?: string | null;
  supplementalDeliveryAppended?: boolean;
  detached?: DetachedDelegationFinalizationInput;
}): DelegationFinalizationReceipt {
  const workerResult = input.executionPlan.producesPatches
    ? buildWorkerResult({
        workerId: input.runId,
        summary: input.message,
        patches: input.patches,
        errorMessage: input.message,
      })
    : undefined;
  const artifactRefs = buildPatchArtifactRefs(input.patches);
  const outcome = buildDelegationFailureOutcome({
    target: input.target,
    taskIdentity: input.taskIdentity,
    runId: input.runId,
    delegate: input.delegate,
    label: input.label,
    childSessionId: input.childSessionId,
    message: input.message,
    status: input.terminalStatus === "failed" ? "error" : input.terminalStatus,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    artifactRefs,
  });
  const baseRecord: DelegationRunRecord = {
    ...(input.currentRecord ?? input.initialRecord),
    ...resolveDelegationRecordIdentity({
      target: input.target,
      delegatedSkillName: input.target.skillName,
    }),
    status: input.terminalStatus,
    updatedAt: input.finishedAt,
    workerSessionId: input.childSessionId,
    modelRoute: input.executionPlan.modelRoute,
    adoption: buildCompletedDelegationAdoption({
      target: input.target,
      resultData: undefined,
      patchChangeCount: workerResult?.patches?.changes.length,
    }),
    summary: input.message,
    error: input.message,
    artifactRefs,
    delivery: input.delivery,
    totalTokens: input.terminalCostSummary?.totalTokens,
    costUsd: input.terminalCostSummary?.totalCostUsd,
  };
  const { outcome: finalOutcome, record } = applyDetachedFinalizationMetadata({
    outcome,
    record: baseRecord,
    runId: input.runId,
    target: input.target,
    label: input.label,
    finishedAt: input.finishedAt,
    detached: input.detached,
  });
  return {
    runId: input.runId,
    parentSessionId: input.parentSessionId,
    outcome: finalOutcome,
    record,
    lifecycleEvent: buildTerminalLifecycleEvent({
      type: input.terminalStatus === "cancelled" ? "subagent_cancelled" : "subagent_failed",
      record,
      terminalPayload: {
        reason: input.cancellationReason ?? null,
        workerStatus: workerResult?.status ?? null,
        patchChangeCount: workerResult?.patches?.changes.length ?? 0,
      },
    }),
    workerResult,
    costRollup: input.terminalCostSummary,
    lineageOutcome: record,
    adoptLineageOutcome: input.supplementalDeliveryAppended === true,
    slotReleaseIntent: workerResult ? "worker_result_recorded" : "release_in_finally",
  };
}

export function applyDelegationFinalizationReceipt(input: {
  runtime: HostedRuntimeAdapterPort;
  receipt: DelegationFinalizationReceipt;
  recordLineageOutcome(record: DelegationRunRecord): void;
  adoptLineageOutcome?(record: DelegationRunRecord): void;
}): void {
  if (input.receipt.costRollup) {
    aggregateChildCost(input.runtime, input.receipt.parentSessionId, input.receipt.costRollup);
  }
  if (input.receipt.parseFailureEvent) {
    recordDelegationRuntimeEvent({
      runtime: input.runtime,
      sessionId: input.receipt.parentSessionId,
      type: input.receipt.parseFailureEvent.type,
      payload: input.receipt.parseFailureEvent.payload,
    });
  }
  if (input.receipt.workerResult) {
    recordRuntimeWorkerResult(
      input.runtime,
      input.receipt.parentSessionId,
      input.receipt.workerResult,
    );
  }
  recordDelegationRuntimeEvent({
    runtime: input.runtime,
    sessionId: input.receipt.parentSessionId,
    type: input.receipt.lifecycleEvent.type,
    payload: input.receipt.lifecycleEvent.payload,
  });
  input.recordLineageOutcome(input.receipt.lineageOutcome);
  if (input.receipt.adoptLineageOutcome) {
    input.adoptLineageOutcome?.(input.receipt.lineageOutcome);
  }
}
