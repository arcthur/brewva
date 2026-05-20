import type {
  DelegationAdoptionRecord,
  DelegationForkTurns,
  DelegationIsolationStrategy,
  DelegationLineageRecord,
  DelegationModelRouteRecord,
  DelegationRunRecord,
  DelegationVisibility,
} from "@brewva/brewva-runtime/protocol";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  evaluateDelegationAdoption,
} from "@brewva/brewva-runtime/protocol";
import type { ToolExecutionBoundary } from "@brewva/brewva-runtime/protocol";
import type { HostedDelegationTarget } from "./targets.js";

export interface DelegationTaskIdentity {
  taskName: string;
  taskPath: string;
  nickname: string;
  depth: number;
}

function normalizeTaskSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "task";
}

function joinTaskPath(parentTaskPath: string | undefined, segment: string): string {
  const parent = parentTaskPath?.trim();
  if (!parent || parent === "/") {
    return `/${segment}`;
  }
  return `${parent.replace(/\/+$/g, "")}/${segment}`;
}

function taskPathDepth(taskPath: string): number {
  return taskPath.split("/").filter((segment) => segment.length > 0).length;
}

export function buildDelegationTaskIdentity(input: {
  target: Pick<HostedDelegationTarget, "agent">;
  requestedTaskName?: string;
  requestedNickname?: string;
  label?: string;
  parentTaskPath?: string;
  reservedTaskPaths?: Iterable<string>;
}): DelegationTaskIdentity {
  // v1 callers pass parentTaskPath only for fanout grouping. Future nested subagents must
  // carry the active parent task path explicitly; this helper only composes what it receives.
  const baseTaskName =
    input.requestedTaskName?.trim() || input.label?.trim() || `${input.target.agent}-task`;
  const baseSegment = normalizeTaskSegment(baseTaskName);
  const reserved = new Set(input.reservedTaskPaths ?? []);
  let suffix = 0;
  let segment = baseSegment;
  let taskPath = joinTaskPath(input.parentTaskPath, segment);
  while (reserved.has(taskPath)) {
    suffix += 1;
    segment = `${baseSegment}-${suffix + 1}`;
    taskPath = joinTaskPath(input.parentTaskPath, segment);
  }
  return {
    taskName: segment,
    taskPath,
    nickname: input.requestedNickname?.trim() || baseTaskName,
    depth: taskPathDepth(taskPath),
  };
}

export function buildInitialDelegationAdoption(
  target: Pick<HostedDelegationTarget, "resultMode">,
): DelegationAdoptionRecord {
  return evaluateDelegationAdoption({
    outcomeKind: target.resultMode,
  });
}

export function buildDelegationContractRecordFields(
  target: Pick<HostedDelegationTarget, "resultMode" | "visibility" | "isolationStrategy">,
): {
  contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  executionPrimitive: "named";
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
  adoption: DelegationAdoptionRecord;
} {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    executionPrimitive: "named",
    visibility: target.visibility,
    isolationStrategy: target.isolationStrategy,
    adoption: buildInitialDelegationAdoption(target),
  };
}

export function buildForkDelegationContractRecordFields(input: {
  parentSessionId: DelegationLineageRecord["parentSessionId"];
  forkTurns: DelegationLineageRecord["forkTurns"];
  isolationStrategy?: DelegationIsolationStrategy;
}): {
  contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  executionPrimitive: "fork";
  visibility: "public";
  isolationStrategy: DelegationIsolationStrategy;
  adoption: DelegationAdoptionRecord;
  lineage: DelegationLineageRecord;
} {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    executionPrimitive: "fork",
    visibility: "public",
    isolationStrategy: input.isolationStrategy ?? "shared",
    adoption: evaluateDelegationAdoption({
      outcomeKind: "consult",
      executionPrimitive: "fork",
    }),
    lineage: {
      parentSessionId: input.parentSessionId,
      forkTurns: input.forkTurns,
    },
  };
}

export function buildCompletedDelegationAdoption(input: {
  target: Pick<HostedDelegationTarget, "resultMode">;
  executionPrimitive?: DelegationRunRecord["executionPrimitive"];
  resultData?: Record<string, unknown>;
  patchChangeCount?: number;
  skillValidationOk?: boolean;
}): DelegationAdoptionRecord {
  return evaluateDelegationAdoption({
    outcomeKind: input.target.resultMode,
    executionPrimitive: input.executionPrimitive,
    resultData: input.resultData,
    patchChangeCount: input.patchChangeCount,
    skillValidationOk: input.skillValidationOk,
  });
}

export function resolveDelegationRecordIdentity(input: {
  target: HostedDelegationTarget;
  delegate?: string;
  delegatedSkillName?: string;
}): Pick<
  DelegationRunRecord,
  "agent" | "targetName" | "delegate" | "agentSpec" | "envelope" | "skillName" | "consultKind"
> {
  return {
    agent: input.target.agent,
    targetName: input.target.targetName,
    delegate:
      input.delegate ??
      input.target.agentSpecName ??
      input.target.envelopeName ??
      input.target.name,
    agentSpec: input.target.agentSpecName,
    envelope: input.target.envelopeName,
    skillName: input.delegatedSkillName ?? input.target.skillName,
    consultKind: input.target.consultKind,
  };
}

export function buildDelegationRunRecordSeed(input: {
  runId: string;
  target: HostedDelegationTarget;
  parentSessionId: DelegationRunRecord["parentSessionId"];
  createdAt: number;
  updatedAt?: number;
  delegate?: string;
  delegatedSkillName?: string;
  status?: DelegationRunRecord["status"];
  label?: string;
  parentSkill?: string;
  boundary?: ToolExecutionBoundary;
  taskIdentity: DelegationTaskIdentity;
  forkTurns?: DelegationForkTurns;
  modelRoute?: DelegationModelRouteRecord;
  delivery?: DelegationRunRecord["delivery"];
  workerSessionId?: DelegationRunRecord["workerSessionId"];
}): DelegationRunRecord {
  return {
    runId: input.runId,
    ...buildDelegationContractRecordFields(input.target),
    ...resolveDelegationRecordIdentity({
      target: input.target,
      delegate: input.delegate,
      delegatedSkillName: input.delegatedSkillName,
    }),
    parentSessionId: input.parentSessionId,
    status: input.status ?? "pending",
    taskName: input.taskIdentity.taskName,
    taskPath: input.taskIdentity.taskPath,
    nickname: input.taskIdentity.nickname,
    depth: input.taskIdentity.depth,
    forkTurns: input.forkTurns ?? "none",
    gateReason: input.target.gateReason,
    modelCategory: input.target.modelCategory,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    label: input.label,
    parentSkill: input.parentSkill,
    kind: input.target.resultMode,
    boundary: input.boundary,
    modelRoute: input.modelRoute,
    delivery: input.delivery,
    workerSessionId: input.workerSessionId,
  };
}
