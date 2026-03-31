import type { ManagedToolMode } from "@brewva/brewva-runtime";
import type {
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools";
import {
  asBoundary,
  asBuiltinToolArray,
  asContextBudget,
  asManagedToolMode,
  asResultMode,
  asString,
  asStringArray,
  readHostedWorkspaceSubagentConfigFiles,
} from "./config-files.js";
import { getDefaultAgentSpecNameForResultMode } from "./protocol.js";
import type { HostedDelegationBuiltinToolName, HostedDelegationTarget } from "./targets.js";

export interface HostedExecutionEnvelope {
  name: string;
  description: string;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  builtinToolNames?: HostedDelegationBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
}

export interface HostedAgentSpec {
  name: string;
  description: string;
  envelope: string;
  skillName?: string;
  fallbackResultMode?: SubagentResultMode;
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
}): HostedAgentSpec {
  return {
    name: input.name,
    description: input.description,
    envelope: "readonly-reviewer",
    fallbackResultMode: "review",
    executorPreamble: input.executorPreamble,
  };
}

const MAX_EXECUTOR_PREAMBLE_LENGTH = 600;
const MAX_AGENT_INSTRUCTIONS_MARKDOWN_LENGTH = 4_000;

const BOUNDARY_RANK: Record<SubagentExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

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
  if (base.managedToolMode === "direct" && candidate.managedToolMode === "runtime_plugin") {
    throw new Error(`${context}:managedToolMode cannot widen beyond direct`);
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

function toExecutionEnvelope(
  source: Record<string, unknown>,
  defaults?: HostedExecutionEnvelope,
): HostedExecutionEnvelope | undefined {
  const name = asString(source.name) ?? defaults?.name;
  const description = asString(source.description) ?? defaults?.description;
  if (!name || !description) {
    return undefined;
  }
  return {
    name,
    description,
    boundary: asBoundary(source.boundary) ?? defaults?.boundary ?? "safe",
    model: asString(source.model) ?? defaults?.model,
    builtinToolNames: asBuiltinToolArray(source.builtinToolNames) ?? defaults?.builtinToolNames,
    managedToolNames: asStringArray(source.managedToolNames) ?? defaults?.managedToolNames,
    defaultContextBudget:
      asContextBudget(source.defaultContextBudget) ?? defaults?.defaultContextBudget,
    managedToolMode: asManagedToolMode(source.managedToolMode) ?? defaults?.managedToolMode,
  };
}

function toAgentSpec(
  source: Record<string, unknown>,
  defaults?: HostedAgentSpec,
): HostedAgentSpec | undefined {
  const name = asString(source.name) ?? defaults?.name;
  const description = asString(source.description) ?? defaults?.description;
  const envelope = asString(source.envelope) ?? defaults?.envelope;
  if (!name || !description || !envelope) {
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
    description,
    envelope,
    skillName: asString(source.skillName) ?? defaults?.skillName,
    fallbackResultMode: asResultMode(source.fallbackResultMode) ?? defaults?.fallbackResultMode,
    executorPreamble,
    instructionsMarkdown,
  };
}

const READONLY_MANAGED_TOOLS = [
  "grep",
  "read_spans",
  "look_at",
  "toc_search",
  "toc_document",
  "ast_grep_search",
  "lsp_diagnostics",
  "lsp_find_references",
  "lsp_goto_definition",
  "lsp_symbols",
  "output_search",
  "ledger_query",
  "tape_search",
  "task_view_state",
  "workflow_status",
] as const;

const PATCH_WORKER_TOOLS = READONLY_MANAGED_TOOLS.filter((tool) => tool !== "workflow_status");

export const BUILTIN_EXECUTION_ENVELOPES: Readonly<Record<string, HostedExecutionEnvelope>> = {
  "readonly-scout": {
    name: "readonly-scout",
    description: "Read-only scout envelope for bounded repository investigation.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [...READONLY_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 1800,
      maxTurnTokens: 6000,
    },
    managedToolMode: "direct",
  },
  "readonly-planner": {
    name: "readonly-planner",
    description: "Read-only planning envelope for design and sequencing work.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [...READONLY_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 1800,
      maxTurnTokens: 6500,
    },
    managedToolMode: "direct",
  },
  "readonly-reviewer": {
    name: "readonly-reviewer",
    description: "Read-only reviewer envelope for correctness and merge-risk evaluation.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [...READONLY_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 7000,
    },
    managedToolMode: "direct",
  },
  "readonly-general": {
    name: "readonly-general",
    description: "General read-only envelope for bounded ad hoc delegation.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [...READONLY_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 1600,
      maxTurnTokens: 5500,
    },
    managedToolMode: "direct",
  },
  "verification-runner": {
    name: "verification-runner",
    description: "Read-only verifier envelope for checks, evidence, and confidence gaps.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [...READONLY_MANAGED_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 7000,
    },
    managedToolMode: "direct",
  },
  "patch-worker": {
    name: "patch-worker",
    description: "Isolated patch-worker envelope with editable snapshot-backed workspace access.",
    boundary: "effectful",
    builtinToolNames: ["read", "edit", "write"],
    managedToolNames: [...PATCH_WORKER_TOOLS],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 8000,
    },
    managedToolMode: "direct",
  },
} as const;

export const BUILTIN_AGENT_SPECS: Readonly<Record<string, HostedAgentSpec>> = {
  explore: {
    name: "explore",
    description:
      "Repository-analysis delegate that maps the active surface and impact path with read-only tools.",
    envelope: "readonly-scout",
    skillName: "repository-analysis",
    fallbackResultMode: "exploration",
    executorPreamble:
      "Operate as a read-only repository scout. Gather only the evidence needed for the delegated objective and keep the result merge-friendly.",
  },
  plan: {
    name: "plan",
    description:
      "Design delegate that turns a bounded objective into an executable plan without editing code.",
    envelope: "readonly-planner",
    skillName: "design",
    fallbackResultMode: "exploration",
    executorPreamble:
      "Operate as a read-only planner. Focus on execution slices, risks, verification intent, and concrete next steps.",
  },
  review: {
    name: "review",
    description: "Review delegate for correctness, regressions, and merge-readiness.",
    envelope: "readonly-reviewer",
    skillName: "review",
    fallbackResultMode: "review",
    executorPreamble:
      "Operate as a strict read-only reviewer. Keep findings concrete, high-signal, and evidence-backed.",
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
  general: {
    name: "general",
    description: "General-purpose read-only delegate for bounded ad hoc work.",
    envelope: "readonly-general",
    fallbackResultMode: "exploration",
    executorPreamble:
      "Operate as a bounded read-only delegate. Gather only the context you need and keep the result concise.",
  },
  verification: {
    name: "verification",
    description: "Verification delegate for read-only checks, evidence, and confidence gaps.",
    envelope: "verification-runner",
    fallbackResultMode: "verification",
    executorPreamble:
      "Operate as a read-only verifier. Focus on checks performed, failed or skipped paths, and remaining confidence gaps.",
  },
  "patch-worker": {
    name: "patch-worker",
    description: "Execution-first isolated patch worker preset.",
    envelope: "patch-worker",
    fallbackResultMode: "patch",
    executorPreamble:
      "Operate as an isolated patch worker. Keep edits minimal, preserve surrounding behavior, and summarize the patch concisely.",
  },
} as const;

const DEFAULT_AGENT_SPEC_BY_SKILL_NAME: Readonly<Record<string, string>> = {
  "repository-analysis": "explore",
  design: "plan",
  review: "review",
} as const;

const DEFAULT_FALLBACK_RESULT_MODE_BY_SKILL_NAME: Readonly<Record<string, SubagentResultMode>> = {
  "repository-analysis": "exploration",
  discovery: "exploration",
  design: "exploration",
  "strategy-review": "exploration",
  debugging: "exploration",
  review: "review",
  qa: "verification",
  ship: "verification",
  implementation: "patch",
} as const;

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
  const pendingEnvelopes = entries.filter((entry) => entry.kind === "envelope");
  while (pendingEnvelopes.length > 0) {
    let progressed = false;
    for (let index = 0; index < pendingEnvelopes.length; ) {
      const entry = pendingEnvelopes[index]!;
      const explicitBaseName = asString(entry.parsed.extends);
      const implicitBase = asString(entry.parsed.name)
        ? resolveHostedExecutionEnvelope(catalog, asString(entry.parsed.name))
        : undefined;
      const baseEnvelope = explicitBaseName
        ? resolveHostedExecutionEnvelope(catalog, explicitBaseName)
        : implicitBase;
      if (explicitBaseName && !baseEnvelope) {
        index += 1;
        continue;
      }
      const envelope = toExecutionEnvelope(entry.parsed, baseEnvelope);
      if (!envelope) {
        throw new Error(`invalid_execution_envelope:${entry.fileName}:missing required fields`);
      }
      if (baseEnvelope) {
        assertHostedExecutionEnvelopeTightening(
          baseEnvelope,
          envelope,
          `invalid_execution_envelope:${envelope.name}`,
        );
      }
      catalog.envelopes.set(envelope.name, envelope);
      catalog.workspaceEnvelopeNames.add(envelope.name);
      pendingEnvelopes.splice(index, 1);
      progressed = true;
    }
    if (progressed) {
      continue;
    }
    const unresolved = pendingEnvelopes[0]!;
    const missingBase = asString(unresolved.parsed.extends) ?? "unknown";
    throw new Error(
      `invalid_execution_envelope:${unresolved.fileName}:unknown base '${missingBase}'`,
    );
  }

  const pendingAgentSpecs = entries.filter((entry) => entry.kind === "agentSpec");
  while (pendingAgentSpecs.length > 0) {
    let progressed = false;
    for (let index = 0; index < pendingAgentSpecs.length; ) {
      const entry = pendingAgentSpecs[index]!;
      const explicitBaseName = asString(entry.parsed.extends);
      const sameNameBase = asString(entry.parsed.name)
        ? catalog.agentSpecs.get(asString(entry.parsed.name)!)
        : undefined;
      const baseAgentSpec = explicitBaseName
        ? catalog.agentSpecs.get(explicitBaseName)
        : sameNameBase;
      if (explicitBaseName && !baseAgentSpec) {
        index += 1;
        continue;
      }
      const agentSpec = toAgentSpec(entry.parsed, baseAgentSpec);
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
    "exploration";
  return {
    name: input.agentSpec.name,
    description: input.agentSpec.description,
    resultMode,
    executorPreamble: input.agentSpec.executorPreamble,
    instructionsMarkdown: input.agentSpec.instructionsMarkdown,
    boundary: input.envelope.boundary ?? "safe",
    model: input.envelope.model,
    skillName: input.agentSpec.skillName,
    fallbackResultMode: resultMode,
    agentSpecName: input.agentSpec.name,
    envelopeName: input.envelope.name,
    builtinToolNames: input.envelope.builtinToolNames,
    managedToolNames: input.envelope.managedToolNames,
    defaultContextBudget: input.envelope.defaultContextBudget,
    managedToolMode: input.envelope.managedToolMode,
  };
}

export function buildSyntheticHostedDelegationTarget(input: {
  name: string;
  description: string;
  envelope: HostedExecutionEnvelope;
  skillName?: string;
  fallbackResultMode?: SubagentResultMode;
  executorPreamble?: string;
  instructionsMarkdown?: string;
}): HostedDelegationTarget {
  const resultMode =
    input.fallbackResultMode ??
    deriveFallbackResultModeForSkillName(input.skillName) ??
    "exploration";
  return {
    name: input.name,
    description: input.description,
    resultMode,
    executorPreamble: input.executorPreamble,
    instructionsMarkdown: input.instructionsMarkdown,
    boundary: input.envelope.boundary ?? "safe",
    model: input.envelope.model,
    skillName: input.skillName,
    fallbackResultMode: resultMode,
    envelopeName: input.envelope.name,
    builtinToolNames: input.envelope.builtinToolNames,
    managedToolNames: input.envelope.managedToolNames,
    defaultContextBudget: input.envelope.defaultContextBudget,
    managedToolMode: input.envelope.managedToolMode,
  };
}

export function deriveDefaultAgentSpecNameForResultMode(resultMode: SubagentResultMode): string {
  return getDefaultAgentSpecNameForResultMode(resultMode);
}
