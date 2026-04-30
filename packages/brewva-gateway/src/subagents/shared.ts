import type {
  BrewvaRuntime,
  DelegationRunRecord,
  DelegationModelRouteRecord,
  DelegationAdoptionRecord,
  DelegationIsolationStrategy,
  DelegationLineageRecord,
  DelegationVisibility,
  ManagedToolMode,
  PatchSet,
  SessionCostSummary,
  ToolExecutionBoundary,
  WorkerResult,
} from "@brewva/brewva-runtime";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  deriveToolGovernanceDescriptor,
  evaluateDelegationAdoption,
  listSkillFallbackTools,
  listSkillPreferredTools,
  resolveSkillEffectLevel,
} from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentExecutionBoundary,
  SubagentExecutionShape,
  SubagentOutcomeArtifactRef,
  SubagentRunRequest,
} from "@brewva/brewva-tools";
import {
  assertHostedExecutionEnvelopeTightening,
  buildHostedDelegationTargetFromAgentSpec,
  deriveDefaultConsultKindForSkillName,
  deriveDefaultAgentSpecNameForResultMode,
  deriveDefaultAgentSpecNameForSkillName,
  deriveFallbackResultModeForSkillName,
  resolveHostedExecutionEnvelope,
  isKnownDelegationSkillName,
  type HostedDelegationCatalog,
} from "./catalog.js";
import {
  resolveDelegationModelRoute,
  type DelegationModelRoutingContext,
} from "./model-routing.js";
import { getCanonicalSubagentPrompt } from "./protocol.js";
import type { HostedDelegationBuiltinToolName, HostedDelegationTarget } from "./targets.js";

const ALL_BUILTIN_SUBAGENT_TOOLS = ["read", "edit", "write"] as const;
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

const BOUNDARY_RANK: Record<ToolExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

function isBuiltinSubagentToolName(value: string): value is HostedDelegationBuiltinToolName {
  return value === "read" || value === "edit" || value === "write";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function mostRestrictiveBoundary(
  ...boundaries: Array<SubagentExecutionBoundary | undefined>
): SubagentExecutionBoundary {
  const defined = boundaries.filter((entry): entry is SubagentExecutionBoundary => Boolean(entry));
  if (defined.length === 0) {
    return "safe";
  }
  return defined.reduce((best, candidate) =>
    BOUNDARY_RANK[candidate] < BOUNDARY_RANK[best] ? candidate : best,
  );
}

export interface ResolvedDelegationTarget {
  target: HostedDelegationTarget;
  delegate: string;
}

export interface ResolvedDelegationExecutionPlan {
  target: HostedDelegationTarget;
  delegate: string;
  packet: DelegationPacket;
  boundary: SubagentExecutionBoundary;
  model?: string;
  modelRoute?: DelegationModelRouteRecord;
  managedToolMode: ManagedToolMode;
  builtinToolNames: HostedDelegationBuiltinToolName[];
  managedToolNames: string[];
  producesPatches: boolean;
  contextProfile: HostedDelegationTarget["contextProfile"];
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
  prompt: string;
}

export function sanitizeFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

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

export function formatSkillValidationError(input: {
  skillName: string;
  missing: readonly string[];
  invalid: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const parts: string[] = [];
  if (input.missing.length > 0) {
    parts.push(`missing=${input.missing.join(",")}`);
  }
  if (input.invalid.length > 0) {
    parts.push(
      `invalid=${input.invalid.map((entry) => `${entry.name}:${entry.reason}`).join(",")}`,
    );
  }
  return `subagent_skill_outputs_invalid:${input.skillName}${parts.length > 0 ? `:${parts.join(";")}` : ""}`;
}

function boundaryWithinCeiling(
  boundary: ToolExecutionBoundary | undefined,
  ceiling: SubagentExecutionBoundary,
): boolean {
  return BOUNDARY_RANK[boundary ?? "safe"] <= BOUNDARY_RANK[ceiling];
}

function resolveRuntimeToolBoundary(
  runtime: BrewvaRuntime,
  toolName: string,
): ToolExecutionBoundary | undefined {
  const policy = runtime.inspect.tools.getActionPolicy(toolName);
  return policy ? deriveToolGovernanceDescriptor(policy).boundary : undefined;
}

function hintedToolNames(packet: DelegationPacket | undefined): string[] {
  return uniqueStrings([
    ...(packet?.executionHints?.preferredTools ?? []),
    ...(packet?.executionHints?.fallbackTools ?? []),
  ]);
}

function resolveSkillToolHints(runtime: BrewvaRuntime, skillName: string | undefined): string[] {
  if (!skillName) {
    return [];
  }
  const skill = runtime.inspect.skills.get(skillName);
  if (!skill) {
    return [];
  }
  return uniqueStrings([
    ...listSkillPreferredTools(skill.contract),
    ...listSkillFallbackTools(skill.contract),
  ]);
}

function mergeBuiltinToolNames(
  target: HostedDelegationTarget,
  packet: DelegationPacket | undefined,
  boundary: SubagentExecutionBoundary,
  skillToolNames: readonly string[],
): HostedDelegationBuiltinToolName[] {
  const defaults =
    target.builtinToolNames ??
    (boundary === "effectful" ? [...ALL_BUILTIN_SUBAGENT_TOOLS] : ["read"]);
  const hinted = uniqueStrings([...skillToolNames, ...hintedToolNames(packet)]).filter(
    (toolName): toolName is HostedDelegationBuiltinToolName => isBuiltinSubagentToolName(toolName),
  );
  if (hinted.length === 0) {
    return [...defaults];
  }
  const allowed = new Set(defaults);
  return [
    ...hinted.filter((toolName) => allowed.has(toolName)),
    ...defaults.filter((toolName) => !hinted.includes(toolName)),
  ];
}

function mergeManagedToolNames(
  target: HostedDelegationTarget,
  packet: DelegationPacket | undefined,
  skillToolNames: readonly string[],
): string[] {
  const hinted = uniqueStrings([...skillToolNames, ...hintedToolNames(packet)]).filter(
    (toolName) => !isBuiltinSubagentToolName(toolName),
  );
  const defaults = target.managedToolNames ?? [];
  if (hinted.length === 0) {
    return [...defaults];
  }
  const allowed = new Set(defaults);
  return [
    ...hinted.filter((toolName) => allowed.has(toolName)),
    ...defaults.filter((toolName) => !hinted.includes(toolName)),
  ];
}

export function assertDelegationShapeNarrowing(
  target: HostedDelegationTarget,
  executionShape: SubagentExecutionShape | undefined,
): void {
  if (!executionShape) {
    return;
  }
  if (executionShape.resultMode && executionShape.resultMode !== target.resultMode) {
    throw new Error("subagent_result_mode_override_not_allowed");
  }
  const targetBoundary = target.boundary ?? "safe";
  if (
    executionShape.boundary &&
    BOUNDARY_RANK[executionShape.boundary] > BOUNDARY_RANK[targetBoundary]
  ) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  if (target.managedToolMode === "direct" && executionShape.managedToolMode === "runtime_plugin") {
    throw new Error("subagent_managed_tool_mode_widening_not_allowed");
  }
}

function assertConsultPacketContract(
  target: HostedDelegationTarget,
  packet: DelegationPacket,
): void {
  if (target.resultMode !== "consult") {
    return;
  }
  if (!target.consultKind) {
    throw new Error("missing_consult_kind");
  }
  if (!packet.consultBrief) {
    throw new Error("missing_consult_brief");
  }
}

export function resolveRequestedBoundary(input: {
  target: HostedDelegationTarget;
  executionShape?: SubagentExecutionShape;
  packet?: DelegationPacket;
  skillBoundaryCeiling?: SubagentExecutionBoundary;
}): SubagentExecutionBoundary {
  assertDelegationShapeNarrowing(input.target, input.executionShape);
  const targetBoundary = input.target.boundary ?? "safe";
  const shapeBoundary = input.executionShape?.boundary;
  const packetBoundary = input.packet?.effectCeiling?.boundary;
  const effectiveCeiling = mostRestrictiveBoundary(
    targetBoundary,
    shapeBoundary,
    input.skillBoundaryCeiling,
  );
  if (packetBoundary && BOUNDARY_RANK[packetBoundary] > BOUNDARY_RANK[effectiveCeiling]) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  return mostRestrictiveBoundary(
    targetBoundary,
    shapeBoundary,
    packetBoundary,
    input.skillBoundaryCeiling,
  );
}

export function resolveBuiltinToolNamesForRun(
  runtime: BrewvaRuntime,
  target: HostedDelegationTarget,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): HostedDelegationBuiltinToolName[] {
  const requested = mergeBuiltinToolNames(
    target,
    packet,
    boundary,
    resolveSkillToolHints(runtime, target.skillName),
  );
  return requested.filter((toolName) =>
    boundaryWithinCeiling(resolveRuntimeToolBoundary(runtime, toolName), boundary),
  );
}

export function resolveManagedToolNamesForRun(
  runtime: BrewvaRuntime,
  target: HostedDelegationTarget,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): string[] {
  const requested = mergeManagedToolNames(
    target,
    packet,
    resolveSkillToolHints(runtime, target.skillName),
  );
  return requested.filter((toolName) => {
    if (
      toolName === "subagent_run" ||
      toolName === "subagent_fanout" ||
      toolName === "subagent_fork" ||
      toolName === "subagent_run_diagnostic" ||
      toolName === "subagent_status" ||
      toolName === "subagent_cancel"
    ) {
      return false;
    }
    return boundaryWithinCeiling(resolveRuntimeToolBoundary(runtime, toolName), boundary);
  });
}

export function resolveDelegationTarget(input: {
  request: Pick<
    SubagentRunRequest,
    "agentSpec" | "envelope" | "skillName" | "consultKind" | "fallbackResultMode" | "executionShape"
  >;
  catalog: HostedDelegationCatalog;
}): ResolvedDelegationTarget {
  const requestedAgentSpec = input.request.agentSpec?.trim();
  const requestedResultMode =
    input.request.executionShape?.resultMode ?? input.request.fallbackResultMode;
  let resolvedAgentSpecName = requestedAgentSpec;
  const derivedFromSkillName = !requestedAgentSpec && Boolean(input.request.skillName);
  const skillNameAgentSpec = input.request.skillName
    ? input.catalog.agentSpecs.get(input.request.skillName)
    : undefined;
  if (
    input.request.skillName &&
    !requestedAgentSpec &&
    !input.request.envelope &&
    !isKnownDelegationSkillName(input.request.skillName) &&
    !skillNameAgentSpec
  ) {
    throw new Error(`unknown_delegation_skill:${input.request.skillName}`);
  }
  if (!resolvedAgentSpecName && !input.request.envelope) {
    if (input.request.skillName) {
      resolvedAgentSpecName =
        deriveDefaultAgentSpecNameForSkillName(input.request.skillName) ?? skillNameAgentSpec?.name;
      if (!resolvedAgentSpecName) {
        throw new Error(`missing_default_agent_spec_for_skill:${input.request.skillName}`);
      }
    } else if (requestedResultMode) {
      resolvedAgentSpecName = deriveDefaultAgentSpecNameForResultMode(requestedResultMode);
      if (!resolvedAgentSpecName) {
        throw new Error(`missing_default_agent_spec_for_result_mode:${requestedResultMode}`);
      }
    }
  }

  const resolvedAgentSpec = resolvedAgentSpecName
    ? input.catalog.agentSpecs.get(resolvedAgentSpecName)
    : undefined;

  if (resolvedAgentSpecName && !resolvedAgentSpec) {
    throw new Error(`unknown_agent_spec:${resolvedAgentSpecName}`);
  }

  if (resolvedAgentSpec) {
    if (
      input.request.skillName &&
      resolvedAgentSpec.skillName &&
      input.request.skillName !== resolvedAgentSpec.skillName &&
      !derivedFromSkillName
    ) {
      throw new Error("conflicting_agent_spec_and_skill_name");
    }
    const baseEnvelope = resolveHostedExecutionEnvelope(input.catalog, resolvedAgentSpec.envelope);
    const requestedEnvelope = resolveHostedExecutionEnvelope(input.catalog, input.request.envelope);
    const resolvedSkillName =
      input.request.skillName && isKnownDelegationSkillName(input.request.skillName)
        ? input.request.skillName
        : resolvedAgentSpec.skillName;
    const derivedConsultKind =
      input.request.consultKind ??
      resolvedAgentSpec.defaultConsultKind ??
      deriveDefaultConsultKindForSkillName(input.request.skillName) ??
      (derivedFromSkillName &&
      !isKnownDelegationSkillName(input.request.skillName) &&
      (resolvedAgentSpec.fallbackResultMode ?? "consult") === "consult"
        ? "investigate"
        : undefined);
    if (!baseEnvelope) {
      throw new Error(`unknown_envelope:${resolvedAgentSpec.envelope}`);
    }
    if (input.request.envelope && !requestedEnvelope) {
      throw new Error(`unknown_envelope:${input.request.envelope}`);
    }
    if (requestedEnvelope && requestedEnvelope.name !== baseEnvelope.name) {
      assertHostedExecutionEnvelopeTightening(
        baseEnvelope,
        requestedEnvelope,
        "conflicting_agent_spec_and_envelope",
      );
    }
    const envelope = requestedEnvelope ?? baseEnvelope;
    const target = buildHostedDelegationTargetFromAgentSpec({
      agentSpec: {
        ...resolvedAgentSpec,
        skillName: resolvedSkillName,
        defaultConsultKind: derivedConsultKind,
        fallbackResultMode:
          input.request.fallbackResultMode ??
          input.request.executionShape?.resultMode ??
          deriveFallbackResultModeForSkillName(input.request.skillName) ??
          resolvedAgentSpec.fallbackResultMode,
      },
      envelope,
    });
    if (target.resultMode === "consult" && !target.consultKind) {
      throw new Error("missing_consult_kind");
    }
    if (target.reviewLane && target.consultKind !== "review") {
      throw new Error("invalid_review_lane_consult_kind");
    }
    assertDelegationShapeNarrowing(target, input.request.executionShape);
    return {
      target,
      delegate: target.agentSpecName ?? target.name,
    };
  }

  if (input.request.envelope) {
    throw new Error("envelope_requires_agent_spec");
  }

  throw new Error("missing_agent_spec_or_skill_name");
}

export function resolveDelegationExecutionPlan(input: {
  runtime: BrewvaRuntime;
  target: HostedDelegationTarget;
  delegate?: string;
  packet: DelegationPacket;
  executionShape?: SubagentExecutionShape;
  modelRouting?: DelegationModelRoutingContext;
  preselectedModelRoute?: DelegationModelRouteRecord;
}): ResolvedDelegationExecutionPlan {
  assertConsultPacketContract(input.target, input.packet);
  const delegatedSkillName = input.target.skillName;
  const skill = delegatedSkillName
    ? input.runtime.inspect.skills.get(delegatedSkillName)
    : undefined;
  const skillBoundaryCeiling =
    skill && resolveSkillEffectLevel(skill.contract) === "read_only" ? "safe" : undefined;
  const boundary = resolveRequestedBoundary({
    target: input.target,
    executionShape: input.executionShape,
    packet: input.packet,
    skillBoundaryCeiling,
  });
  const managedToolMode =
    input.executionShape?.managedToolMode ?? input.target.managedToolMode ?? "direct";
  const prompt =
    input.target.executorPreamble ??
    getCanonicalSubagentPrompt(input.target.resultMode, input.target.consultKind);
  const routedModel = resolveDelegationModelRoute({
    target: input.target,
    packet: input.packet,
    executionShape: input.executionShape,
    modelRouting: input.modelRouting,
    preselectedModelRoute: input.preselectedModelRoute,
  });
  return {
    target: input.target,
    delegate:
      input.delegate ??
      input.target.agentSpecName ??
      input.target.envelopeName ??
      input.target.name,
    packet: input.packet,
    boundary,
    model: routedModel.model,
    modelRoute: routedModel.modelRoute,
    managedToolMode,
    builtinToolNames: resolveBuiltinToolNamesForRun(
      input.runtime,
      { ...input.target, skillName: delegatedSkillName },
      boundary,
      input.packet,
    ),
    managedToolNames: resolveManagedToolNamesForRun(
      input.runtime,
      { ...input.target, skillName: delegatedSkillName },
      boundary,
      input.packet,
    ),
    producesPatches: input.target.producesPatches,
    contextProfile: input.target.contextProfile,
    visibility: input.target.visibility,
    isolationStrategy: input.target.isolationStrategy,
    prompt,
  };
}

export function aggregateChildCost(
  runtime: BrewvaRuntime,
  parentSessionId: string,
  childSummary: SessionCostSummary,
): void {
  for (const [model, totals] of Object.entries(childSummary.models)) {
    if (totals.totalTokens <= 0 && totals.totalCostUsd <= 0) {
      continue;
    }
    runtime.authority.cost.recordAssistantUsage({
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
