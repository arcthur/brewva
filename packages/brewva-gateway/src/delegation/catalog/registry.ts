import type {
  DelegationGateReason,
  DelegationIsolationStrategy,
  DelegationModelCategory,
  PublicSubagentRole,
  DelegationVisibility,
} from "@brewva/brewva-runtime/protocol";
import type { ManagedToolMode } from "@brewva/brewva-runtime/protocol";
import { normalizeReviewLaneName } from "@brewva/brewva-runtime/protocol";
import type {
  ExplorerConsultKind,
  ReviewLaneName,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools/contracts";
import {
  asString,
  asStringArray,
  readHostedWorkspaceSubagentConfigFiles,
} from "../config-files.js";
import { getDefaultAgentSpecNameForResultMode } from "../protocol.js";
import type { HostedDelegationBuiltinToolName, HostedDelegationTarget } from "../targets.js";
import {
  EXPLORER_SPECIALIST_CONSTITUTION,
  LIBRARIAN_SPECIALIST_CONSTITUTION,
  NAVIGATOR_SPECIALIST_CONSTITUTION,
  VERIFIER_SPECIALIST_CONSTITUTION,
  REVIEW_OPERABILITY_SPECIALIST_CONSTITUTION,
  WORKER_SPECIALIST_CONSTITUTION,
} from "./constitutions.js";

export interface HostedExecutionEnvelope {
  name: string;
  description: string;
  boundary?: SubagentExecutionBoundary;
  isolationStrategy: DelegationIsolationStrategy;
  builtinToolNames?: HostedDelegationBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
  producesPatches: boolean;
}

export interface HostedAgentSpec {
  name: string;
  agent: PublicSubagentRole;
  description: string;
  visibility: DelegationVisibility;
  envelope: string;
  gateReason: DelegationGateReason;
  modelCategory: DelegationModelCategory;
  skillName?: string;
  defaultConsultKind?: ExplorerConsultKind;
  reviewLane?: ReviewLaneName;
  fallbackResultMode?: SubagentResultMode;
  modelPreset?: string;
  reasoningEffort?: string;
  managedToolNames?: string[];
  executorPreamble?: string;
  instructionsMarkdown?: string;
}

export interface HostedDelegationCatalog {
  envelopes: Map<string, HostedExecutionEnvelope>;
  agentSpecs: Map<string, HostedAgentSpec>;
  workspaceEnvelopeNames: Set<string>;
  workspaceAgentSpecNames: Set<string>;
}

function buildReviewLaneAgentSpec(input: {
  name: string;
  description: string;
  executorPreamble: string;
  instructionsMarkdown?: string;
}): HostedAgentSpec {
  return {
    name: input.name,
    agent: "explorer",
    description: input.description,
    visibility: "internal",
    envelope: "explorer-readonly",
    gateReason: "make_judgment",
    modelCategory: "deep-reasoning",
    defaultConsultKind: "review",
    reviewLane: normalizeReviewLaneName(input.name) ?? undefined,
    fallbackResultMode: "consult",
    executorPreamble: input.executorPreamble,
    instructionsMarkdown: input.instructionsMarkdown,
  };
}

const MAX_EXECUTOR_PREAMBLE_LENGTH = 600;
const MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH = 4_000;

const BOUNDARY_RANK: Record<SubagentExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

const ISOLATION_STRATEGY_RANK: Record<DelegationIsolationStrategy, number> = {
  shared: 0,
  ephemeral: 1,
  snapshot: 2,
  worktree: 3,
  container: 4,
};

const PUBLIC_AGENT_SPEC_NAMES = new Set([
  "navigator",
  "explorer",
  "worker",
  "verifier",
  "librarian",
] as const);

const FORBIDDEN_WORKSPACE_AGENT_FIELDS = [
  "kind",
  "model",
  "envelope",
  "skillName",
  "defaultConsultKind",
  "reviewLane",
  "fallbackResultMode",
  "executorPreamble",
  "visibility",
] as const;

function assertSubset(
  context: string,
  fieldName: string,
  base: readonly string[] | undefined,
  candidate: readonly string[] | undefined,
): void {
  if (!base || !candidate) {
    return;
  }
  const allowed = new Set(base);
  const widened = candidate.filter((entry) => !allowed.has(entry));
  if (widened.length > 0) {
    throw new Error(`${context}:${fieldName} widens the base envelope with ${widened.join(", ")}`);
  }
}

function assertBudgetTightening(
  context: string,
  fieldName: keyof NonNullable<HostedExecutionEnvelope["defaultContextBudget"]>,
  baseValue: number | undefined,
  candidateValue: number | undefined,
): void {
  if (baseValue === undefined || candidateValue === undefined) {
    return;
  }
  if (candidateValue > baseValue) {
    throw new Error(`${context}:defaultContextBudget.${fieldName} widens the base budget`);
  }
}

export function assertHostedExecutionEnvelopeTightening(
  base: HostedExecutionEnvelope,
  candidate: HostedExecutionEnvelope,
  context = `invalid_execution_envelope:${candidate.name}`,
): void {
  const baseBoundary = base.boundary ?? "safe";
  const candidateBoundary = candidate.boundary ?? baseBoundary;
  if (BOUNDARY_RANK[candidateBoundary] > BOUNDARY_RANK[baseBoundary]) {
    throw new Error(`${context}:boundary cannot widen beyond the base envelope`);
  }
  assertSubset(context, "builtinToolNames", base.builtinToolNames, candidate.builtinToolNames);
  assertSubset(context, "managedToolNames", base.managedToolNames, candidate.managedToolNames);
  assertBudgetTightening(
    context,
    "maxInjectionTokens",
    base.defaultContextBudget?.maxInjectionTokens,
    candidate.defaultContextBudget?.maxInjectionTokens,
  );
  assertBudgetTightening(
    context,
    "maxTurnTokens",
    base.defaultContextBudget?.maxTurnTokens,
    candidate.defaultContextBudget?.maxTurnTokens,
  );
  if (base.managedToolMode === "direct" && candidate.managedToolMode === "hosted") {
    throw new Error(`${context}:managedToolMode cannot widen beyond direct`);
  }
  if (candidate.producesPatches && !base.producesPatches) {
    throw new Error(`${context}:producesPatches cannot widen beyond the base envelope`);
  }
  if (
    (ISOLATION_STRATEGY_RANK[candidate.isolationStrategy] ?? 0) <
    (ISOLATION_STRATEGY_RANK[base.isolationStrategy] ?? 0)
  ) {
    throw new Error(`${context}:isolationStrategy cannot widen beyond the base envelope`);
  }
}

function assertHostedAgentSpecTightening(input: {
  base: HostedAgentSpec;
  candidate: HostedAgentSpec;
  catalog: HostedDelegationCatalog;
  context: string;
}): void {
  const { base, candidate, catalog, context } = input;
  if (base.skillName && candidate.skillName && base.skillName !== candidate.skillName) {
    throw new Error(`${context}:skillName cannot change from the base agent spec`);
  }
  if (
    base.defaultConsultKind &&
    candidate.defaultConsultKind &&
    base.defaultConsultKind !== candidate.defaultConsultKind
  ) {
    throw new Error(`${context}:defaultConsultKind cannot change from the base agent spec`);
  }
  if (base.reviewLane && candidate.reviewLane && base.reviewLane !== candidate.reviewLane) {
    throw new Error(`${context}:reviewLane cannot change from the base agent spec`);
  }
  if (
    base.fallbackResultMode &&
    candidate.fallbackResultMode &&
    base.fallbackResultMode !== candidate.fallbackResultMode
  ) {
    throw new Error(`${context}:fallbackResultMode cannot change from the base agent spec`);
  }
  if (
    candidate.executorPreamble &&
    candidate.executorPreamble.length > MAX_EXECUTOR_PREAMBLE_LENGTH
  ) {
    throw new Error(
      `${context}:executorPreamble exceeds ${MAX_EXECUTOR_PREAMBLE_LENGTH} characters`,
    );
  }
  if (
    candidate.instructionsMarkdown &&
    candidate.instructionsMarkdown.length > MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH
  ) {
    throw new Error(
      `${context}:instructionsMarkdown exceeds ${MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH} characters`,
    );
  }
  assertSubset(
    context,
    "managedToolNames",
    resolveHostedExecutionEnvelope(catalog, base.envelope)?.managedToolNames,
    candidate.managedToolNames,
  );

  const baseEnvelope = resolveHostedExecutionEnvelope(catalog, base.envelope);
  const candidateEnvelope = resolveHostedExecutionEnvelope(catalog, candidate.envelope);
  if (!baseEnvelope) {
    throw new Error(`${context}:unknown base envelope '${base.envelope}'`);
  }
  if (!candidateEnvelope) {
    throw new Error(`${context}:unknown envelope '${candidate.envelope}'`);
  }
  assertHostedExecutionEnvelopeTightening(baseEnvelope, candidateEnvelope, `${context}:envelope`);
}

function toAgentSpec(
  source: Record<string, unknown>,
  defaults?: HostedAgentSpec,
  options: { workspace?: boolean } = {},
): HostedAgentSpec | undefined {
  if ("model" in source) {
    throw new Error("Agent spec model pins are no longer supported. Use modelPresets.");
  }
  if (options.workspace) {
    const forbidden = FORBIDDEN_WORKSPACE_AGENT_FIELDS.filter((field) =>
      Object.prototype.hasOwnProperty.call(source, field),
    );
    if (forbidden.length > 0) {
      throw new Error(`workspace agent spec fields are not supported: ${forbidden.join(", ")}`);
    }
  }
  const name = asString(source.name) ?? defaults?.name;
  const description = asString(source.description) ?? defaults?.description;
  const envelope = defaults?.envelope;
  const agent = defaults?.agent;
  const gateReason = defaults?.gateReason;
  const modelCategory = defaults?.modelCategory;
  if (!name || !description || !envelope || !agent || !gateReason || !modelCategory) {
    return undefined;
  }
  const executorPreamble = asString(source.executorPreamble) ?? defaults?.executorPreamble;
  const instructionsMarkdown =
    asString(source.instructionsMarkdown) ?? defaults?.instructionsMarkdown;
  if (executorPreamble && executorPreamble.length > MAX_EXECUTOR_PREAMBLE_LENGTH) {
    throw new Error(
      `invalid_agent_spec:${name}:executorPreamble exceeds ${MAX_EXECUTOR_PREAMBLE_LENGTH} characters`,
    );
  }
  if (
    instructionsMarkdown &&
    instructionsMarkdown.length > MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH
  ) {
    throw new Error(
      `invalid_agent_spec:${name}:instructionsMarkdown exceeds ${MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH} characters`,
    );
  }
  return {
    name,
    agent,
    description,
    visibility: defaults?.visibility ?? "diagnostic",
    envelope,
    gateReason,
    modelCategory,
    skillName: defaults?.skillName,
    defaultConsultKind: defaults?.defaultConsultKind,
    reviewLane: defaults?.reviewLane,
    fallbackResultMode: defaults?.fallbackResultMode,
    modelPreset: asString(source.modelPreset) ?? defaults?.modelPreset,
    reasoningEffort: asString(source.reasoningEffort) ?? defaults?.reasoningEffort,
    managedToolNames: asStringArray(source.tools) ?? defaults?.managedToolNames,
    executorPreamble,
    instructionsMarkdown,
  };
}

const NAVIGATOR_MANAGED_TOOLS = [
  "grep",
  "git_status",
  "git_diff",
  "git_log",
  "source_read",
  "resource_read",
  "look_at",
  "code_outline",
  "code_digest",
  "code_surface",
  "code_deps",
  "code_reverse_deps",
  "code_cycles",
  "code_callers",
  "code_callees",
  "lsp_status",
  "lsp_diagnostics",
  "lsp_references",
  "lsp_definition",
  "output_search",
] as const;

const EXPLORER_MANAGED_TOOLS = [
  ...NAVIGATOR_MANAGED_TOOLS,
  "ledger_query",
  "task_view_state",
  "workflow_status",
] as const;

const LIBRARIAN_MANAGED_TOOLS = [
  "knowledge_search",
  "recall_search",
  "precedent_sweep",
  "precedent_audit",
  "source_read",
  "resource_read",
  "look_at",
  "code_outline",
  "code_digest",
  "code_surface",
] as const;

const WORKER_TOOLS = EXPLORER_MANAGED_TOOLS.filter((tool) => tool !== "workflow_status");
const VERIFIER_MANAGED_TOOLS = [
  ...EXPLORER_MANAGED_TOOLS,
  "exec",
  "browser_open",
  "browser_wait",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_get",
  "browser_screenshot",
  "browser_diff_snapshot",
] as const;

export const BUILTIN_EXECUTION_ENVELOPES: Readonly<Record<string, HostedExecutionEnvelope>> = {
  "navigator-readonly": {
    name: "navigator-readonly",
    description: "Task-local evidence discovery envelope with no institutional recall tools.",
    boundary: "safe",
    isolationStrategy: "shared",
    builtinToolNames: ["read"],
    managedToolNames: [...NAVIGATOR_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 1800,
      maxTurnTokens: 6500,
    },
    managedToolMode: "direct",
    producesPatches: false,
  },
  "explorer-readonly": {
    name: "explorer-readonly",
    description: "Read-only judgment envelope for diagnosis, design, review, and risk calls.",
    boundary: "safe",
    isolationStrategy: "shared",
    builtinToolNames: ["read"],
    managedToolNames: [...EXPLORER_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 7000,
    },
    managedToolMode: "direct",
    producesPatches: false,
  },
  "librarian-readonly": {
    name: "librarian-readonly",
    description: "Institutional knowledge envelope for precedents, conventions, and proposals.",
    boundary: "safe",
    isolationStrategy: "shared",
    builtinToolNames: ["read"],
    managedToolNames: [...LIBRARIAN_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2200,
      maxTurnTokens: 7600,
    },
    managedToolMode: "direct",
    producesPatches: false,
  },
  "verifier-runner": {
    name: "verifier-runner",
    description:
      "Effectful but non-patch-producing verifier envelope for executable checks and adversarial probes.",
    boundary: "effectful",
    isolationStrategy: "ephemeral",
    builtinToolNames: ["read"],
    managedToolNames: [...VERIFIER_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 8500,
    },
    managedToolMode: "direct",
    producesPatches: false,
  },
  worker: {
    name: "worker",
    description: "Isolated worker envelope with editable snapshot-backed workspace access.",
    boundary: "effectful",
    isolationStrategy: "snapshot",
    builtinToolNames: ["read", "edit", "write"],
    managedToolNames: [...WORKER_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 8000,
    },
    managedToolMode: "direct",
    producesPatches: true,
  },
} as const;

export const BUILTIN_AGENT_SPECS: Readonly<Record<string, HostedAgentSpec>> = {
  navigator: {
    name: "navigator",
    agent: "navigator",
    description: "Task-local evidence finder that stops before design judgment.",
    visibility: "public",
    envelope: "navigator-readonly",
    gateReason: "find_evidence",
    modelCategory: "fast-evidence",
    fallbackResultMode: "evidence",
    executorPreamble:
      "Operate as a navigator. Find task-local evidence, cite sources, and stop before recommendation or design judgment.",
    instructionsMarkdown: NAVIGATOR_SPECIALIST_CONSTITUTION,
  },
  explorer: {
    name: "explorer",
    agent: "explorer",
    description: "Read-only explorer for diagnosis, design judgment, review, and risk decisions.",
    visibility: "public",
    envelope: "explorer-readonly",
    gateReason: "make_judgment",
    modelCategory: "deep-reasoning",
    fallbackResultMode: "consult",
    executorPreamble:
      "Operate as an explorer. Use evidence to make a bounded judgment, preserve counterevidence, and recommend the parent's next decision.",
    instructionsMarkdown: EXPLORER_SPECIALIST_CONSTITUTION,
  },
  "review-correctness": buildReviewLaneAgentSpec({
    name: "review-correctness",
    description: "Review lane for behavioral correctness, invariants, and regression risk.",
    executorPreamble:
      "Operate as the correctness and invariants lane. Focus on behavior drift, unsafe assumptions, broken invariants, and concrete regression risk.",
  }),
  "review-boundaries": buildReviewLaneAgentSpec({
    name: "review-boundaries",
    description: "Review lane for contracts, ownership boundaries, and public-surface drift.",
    executorPreamble:
      "Operate as the contracts and boundaries lane. Focus on ownership, interface drift, package boundaries, and contract mismatches that can break callers or downstream systems.",
  }),
  "review-operability": buildReviewLaneAgentSpec({
    name: "review-operability",
    description: "Review lane for verification posture, rollbackability, and operator burden.",
    executorPreamble:
      "Operate as the verification and operability lane. Focus on missing evidence, weak rollback posture, deploy-time risk, and operator-visible failure burden.",
    instructionsMarkdown: REVIEW_OPERABILITY_SPECIALIST_CONSTITUTION,
  }),
  "review-security": buildReviewLaneAgentSpec({
    name: "review-security",
    description: "Review lane for trust boundaries, credentials, permissions, and misuse risk.",
    executorPreamble:
      "Operate as the security lane. Focus on trust boundaries, credentials, permissions, untrusted input, misuse paths, and externally exposed attack surface.",
  }),
  "review-concurrency": buildReviewLaneAgentSpec({
    name: "review-concurrency",
    description: "Review lane for replay ordering, async coordination, and state-transition races.",
    executorPreamble:
      "Operate as the concurrency lane. Focus on replay ordering, async coordination, rollback interactions, scheduling, and multi-session state transition races.",
  }),
  "review-compatibility": buildReviewLaneAgentSpec({
    name: "review-compatibility",
    description: "Review lane for CLI, config, API, export, and persisted-format compatibility.",
    executorPreamble:
      "Operate as the compatibility lane. Focus on CLI behavior, config semantics, exports, persisted formats, public APIs, and wire-protocol drift.",
  }),
  "review-performance": buildReviewLaneAgentSpec({
    name: "review-performance",
    description: "Review lane for hot-path cost, scaling limits, and artifact-volume regressions.",
    executorPreamble:
      "Operate as the performance lane. Focus on hot paths, wide scans, indexing, queue growth, fan-out cost, and artifact-volume regressions.",
  }),
  verifier: {
    name: "verifier",
    agent: "verifier",
    description:
      "Executable Verifier delegate for adversarial verification without parent-source mutation.",
    visibility: "public",
    envelope: "verifier-runner",
    gateReason: "verify_reproducibly",
    modelCategory: "verification",
    skillName: "verifier",
    fallbackResultMode: "verifier",
    executorPreamble:
      "Operate as an adversarial verifier. Execute real checks, look for breakage, and keep verdicts evidence-backed.",
    instructionsMarkdown: VERIFIER_SPECIALIST_CONSTITUTION,
  },
  worker: {
    name: "worker",
    agent: "worker",
    description: "Execution-first isolated worker preset.",
    visibility: "public",
    envelope: "worker",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    fallbackResultMode: "patch",
    executorPreamble:
      "Operate as an isolated worker. Keep edits minimal, preserve surrounding behavior, and summarize the patch concisely.",
    instructionsMarkdown: WORKER_SPECIALIST_CONSTITUTION,
  },
  librarian: {
    name: "librarian",
    agent: "librarian",
    description: "Read-only institutional knowledge researcher and proposal author.",
    visibility: "public",
    envelope: "librarian-readonly",
    gateReason: "compound_knowledge",
    modelCategory: "knowledge",
    skillName: "learning-research",
    fallbackResultMode: "knowledge",
    executorPreamble:
      "Operate as a librarian. Search institutional knowledge, summarize provenance and conflicts, and return proposals without promoting authority.",
    instructionsMarkdown: LIBRARIAN_SPECIALIST_CONSTITUTION,
  },
} as const;

const DEFAULT_AGENT_SPEC_BY_SKILL_NAME: Readonly<Record<string, string>> = {
  "repository-analysis": "navigator",
  architecture: "explorer",
  "office-hours": "explorer",
  discovery: "navigator",
  "learning-research": "librarian",
  debugging: "explorer",
  strategy: "explorer",
  plan: "explorer",
  review: "explorer",
  "predict-review": "explorer",
  verifier: "verifier",
  implementation: "worker",
} as const;

const DEFAULT_FALLBACK_RESULT_MODE_BY_SKILL_NAME: Readonly<Record<string, SubagentResultMode>> = {
  "repository-analysis": "evidence",
  architecture: "consult",
  "office-hours": "consult",
  discovery: "evidence",
  "learning-research": "knowledge",
  debugging: "consult",
  strategy: "consult",
  plan: "consult",
  review: "consult",
  "predict-review": "consult",
  verifier: "verifier",
  implementation: "patch",
} as const;

const DEFAULT_CONSULT_KIND_BY_SKILL_NAME: Readonly<Record<string, ExplorerConsultKind>> = {
  "repository-analysis": "investigate",
  architecture: "design",
  "office-hours": "design",
  discovery: "investigate",
  "learning-research": "investigate",
  debugging: "diagnose",
  strategy: "design",
  plan: "design",
  review: "review",
  "predict-review": "review",
} as const;

export function isKnownDelegationSkillName(skillName: string | undefined): boolean {
  if (!skillName) {
    return false;
  }
  return (
    Object.hasOwn(DEFAULT_AGENT_SPEC_BY_SKILL_NAME, skillName) ||
    Object.hasOwn(DEFAULT_FALLBACK_RESULT_MODE_BY_SKILL_NAME, skillName)
  );
}

export async function loadHostedDelegationCatalog(
  workspaceRoot: string,
): Promise<HostedDelegationCatalog> {
  const catalog: HostedDelegationCatalog = {
    envelopes: new Map<string, HostedExecutionEnvelope>(
      Object.values(BUILTIN_EXECUTION_ENVELOPES).map(
        (envelope) => [envelope.name, envelope] as const,
      ),
    ),
    agentSpecs: new Map<string, HostedAgentSpec>(
      Object.values(BUILTIN_AGENT_SPECS).map((agentSpec) => [agentSpec.name, agentSpec] as const),
    ),
    workspaceEnvelopeNames: new Set<string>(),
    workspaceAgentSpecNames: new Set<string>(),
  };

  const entries = await readHostedWorkspaceSubagentConfigFiles(workspaceRoot);
  const forbiddenEnvelope = entries.find((entry) => entry.kind === "envelope");
  if (forbiddenEnvelope) {
    throw new Error(
      `invalid_subagent_config:${forbiddenEnvelope.fileName}:workspace execution envelopes are no longer supported`,
    );
  }

  const pendingAgentSpecs = entries.filter((entry) => entry.kind === "agentSpec");
  while (pendingAgentSpecs.length > 0) {
    let progressed = false;
    for (let index = 0; index < pendingAgentSpecs.length; ) {
      const entry = pendingAgentSpecs[index]!;
      const explicitBaseName = asString(entry.parsed.extends);
      if (!explicitBaseName) {
        throw new Error(`invalid_agent_spec:${entry.fileName}:extends is required`);
      }
      if (
        !PUBLIC_AGENT_SPEC_NAMES.has(
          explicitBaseName as "navigator" | "explorer" | "worker" | "verifier" | "librarian",
        )
      ) {
        throw new Error(
          `invalid_agent_spec:${entry.fileName}:extends must be navigator, explorer, worker, verifier, or librarian`,
        );
      }
      const baseAgentSpec = catalog.agentSpecs.get(explicitBaseName);
      if (!baseAgentSpec) {
        index += 1;
        continue;
      }
      const agentSpec = toAgentSpec(entry.parsed, baseAgentSpec, { workspace: true });
      if (!agentSpec) {
        throw new Error(`invalid_agent_spec:${entry.fileName}:missing required fields`);
      }
      if (!resolveHostedExecutionEnvelope(catalog, agentSpec.envelope)) {
        throw new Error(
          `invalid_agent_spec:${entry.fileName}:unknown envelope '${agentSpec.envelope}'`,
        );
      }
      if (baseAgentSpec) {
        assertHostedAgentSpecTightening({
          base: baseAgentSpec,
          candidate: agentSpec,
          catalog,
          context: `invalid_agent_spec:${agentSpec.name}`,
        });
      }
      catalog.agentSpecs.set(agentSpec.name, agentSpec);
      catalog.workspaceAgentSpecNames.add(agentSpec.name);
      pendingAgentSpecs.splice(index, 1);
      progressed = true;
    }
    if (progressed) {
      continue;
    }
    const unresolved = pendingAgentSpecs[0]!;
    const missingBase = asString(unresolved.parsed.extends) ?? "unknown";
    throw new Error(`invalid_agent_spec:${unresolved.fileName}:unknown base '${missingBase}'`);
  }

  return catalog;
}

export function resolveHostedExecutionEnvelope(
  catalog: HostedDelegationCatalog,
  name: string | undefined,
): HostedExecutionEnvelope | undefined {
  if (!name) {
    return undefined;
  }
  return catalog.envelopes.get(name);
}

export function deriveFallbackResultModeForSkillName(
  skillName: string | undefined,
): SubagentResultMode | undefined {
  if (!skillName) {
    return undefined;
  }
  return DEFAULT_FALLBACK_RESULT_MODE_BY_SKILL_NAME[skillName];
}

export function deriveDefaultConsultKindForSkillName(
  skillName: string | undefined,
): ExplorerConsultKind | undefined {
  if (!skillName) {
    return undefined;
  }
  return DEFAULT_CONSULT_KIND_BY_SKILL_NAME[skillName];
}

export function deriveDefaultAgentSpecNameForSkillName(
  skillName: string | undefined,
): string | undefined {
  if (!skillName) {
    return undefined;
  }
  return DEFAULT_AGENT_SPEC_BY_SKILL_NAME[skillName];
}

export function buildHostedDelegationTargetFromAgentSpec(input: {
  agentSpec: HostedAgentSpec;
  envelope: HostedExecutionEnvelope;
}): HostedDelegationTarget {
  const resultMode =
    input.agentSpec.fallbackResultMode ??
    deriveFallbackResultModeForSkillName(input.agentSpec.skillName) ??
    "consult";
  const consultKind = resultMode === "consult" ? input.agentSpec.defaultConsultKind : undefined;
  return {
    name: input.agentSpec.name,
    agent: input.agentSpec.agent,
    targetName: input.agentSpec.name,
    description: input.agentSpec.description,
    visibility: input.agentSpec.visibility,
    resultMode,
    modelCategory: input.agentSpec.modelCategory,
    gateReason: input.agentSpec.gateReason,
    executorPreamble: input.agentSpec.executorPreamble,
    instructionsMarkdown: input.agentSpec.instructionsMarkdown,
    boundary: input.envelope.boundary ?? "safe",
    skillName: input.agentSpec.skillName,
    consultKind,
    reviewLane: input.agentSpec.reviewLane,
    fallbackResultMode: resultMode,
    agentSpecName: input.agentSpec.name,
    envelopeName: input.envelope.name,
    builtinToolNames: input.envelope.builtinToolNames,
    managedToolNames: input.agentSpec.managedToolNames ?? input.envelope.managedToolNames,
    defaultContextBudget: input.envelope.defaultContextBudget,
    managedToolMode: input.envelope.managedToolMode,
    producesPatches: input.envelope.producesPatches,
    isolationStrategy: input.envelope.isolationStrategy,
  };
}

export function deriveDefaultAgentSpecNameForResultMode(resultMode: SubagentResultMode): string {
  return getDefaultAgentSpecNameForResultMode(resultMode);
}
