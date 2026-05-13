import type {
  DelegationAdoptionRecord,
  DelegationIsolationStrategy,
  DelegationLineageRecord,
  DelegationModelRouteRecord,
  DelegationRunRecord,
  DelegationVisibility,
} from "@brewva/brewva-runtime/delegation";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  evaluateDelegationAdoption,
} from "@brewva/brewva-runtime/delegation";
import type { ToolExecutionBoundary } from "@brewva/brewva-runtime/governance";
import type { HostedDelegationTarget } from "./targets.js";

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
  contextPolicy: DelegationLineageRecord["contextPolicy"];
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
      contextPolicy: input.contextPolicy,
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
}): Pick<DelegationRunRecord, "delegate" | "agentSpec" | "envelope" | "skillName" | "consultKind"> {
  return {
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
