import type {
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolGovernanceResolver,
  ToolGovernanceResolverInput,
  ToolGovernanceRisk,
} from "../contracts/index.js";
import { normalizeToolName } from "../utils/tool-name.js";

function descriptor(input: {
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  boundary?: ToolExecutionBoundary;
  rollbackable?: boolean;
}): ToolGovernanceDescriptor {
  return {
    effects: input.effects,
    defaultRisk: input.defaultRisk,
    boundary: input.boundary ?? resolveToolExecutionBoundaryFromEffects(input.effects),
    rollbackable: input.rollbackable,
  };
}

function normalizeDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
    boundary: input.boundary ?? resolveToolExecutionBoundaryFromEffects(input.effects),
    rollbackable: input.rollbackable,
  };
}

export function resolveToolExecutionBoundaryFromEffects(
  effects: readonly ToolEffectClass[],
): ToolExecutionBoundary {
  return effects.some((effect) => effect !== "workspace_read" && effect !== "runtime_observe")
    ? "effectful"
    : "safe";
}

export function toolEffectsRequireEffectCommitment(effects: readonly ToolEffectClass[]): boolean {
  return effects.some(
    (effect) =>
      effect === "local_exec" ||
      effect === "external_network" ||
      effect === "external_side_effect" ||
      effect === "schedule_mutation",
  );
}

export function toolEffectsCreateRollbackAnchor(effects: readonly ToolEffectClass[]): boolean {
  return !toolEffectsRequireEffectCommitment(effects) && effects.includes("workspace_write");
}

export type ToolGovernanceDescriptorSource = "registry" | "exact" | "hint" | "missing";

export interface ToolGovernanceResolution {
  descriptor?: ToolGovernanceDescriptor;
  source: ToolGovernanceDescriptorSource;
}

export interface ResolvedToolAuthority {
  normalizedToolName: string;
  descriptor?: ToolGovernanceDescriptor;
  source: ToolGovernanceDescriptorSource;
  boundary: ToolExecutionBoundary;
  requiresApproval: boolean;
  rollbackable: boolean;
}

function sameEffects(
  left: readonly ToolEffectClass[] | undefined,
  right: readonly ToolEffectClass[] | undefined,
): boolean {
  const leftValues = [...new Set(left ?? [])].toSorted();
  const rightValues = [...new Set(right ?? [])].toSorted();
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

const NARRATIVE_MEMORY_READ_ACTIONS = new Set(["list", "show", "retrieve", "stats"]);
const NARRATIVE_MEMORY_MEMORY_WRITE_ACTIONS = new Set(["remember", "review", "archive", "forget"]);

const NARRATIVE_MEMORY_DEFAULT_DESCRIPTOR = descriptor({
  effects: ["runtime_observe", "memory_write", "workspace_write"],
  defaultRisk: "medium",
  rollbackable: false,
});

const NARRATIVE_MEMORY_READ_DESCRIPTOR = descriptor({
  effects: ["runtime_observe"],
  defaultRisk: "low",
});

const NARRATIVE_MEMORY_MEMORY_WRITE_DESCRIPTOR = descriptor({
  effects: ["memory_write"],
  defaultRisk: "medium",
});

const NARRATIVE_MEMORY_PROMOTE_DESCRIPTOR = descriptor({
  effects: ["memory_write", "workspace_write"],
  defaultRisk: "medium",
  rollbackable: false,
});

function readActionArgument(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  const value = args.action;
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveNarrativeMemoryDescriptor(
  input: ToolGovernanceResolverInput,
): ToolGovernanceDescriptor | undefined {
  if (normalizeToolName(input.toolName) !== "narrative_memory") {
    return undefined;
  }
  const action = readActionArgument(input.args);
  if (!action) {
    return NARRATIVE_MEMORY_DEFAULT_DESCRIPTOR;
  }
  if (NARRATIVE_MEMORY_READ_ACTIONS.has(action)) {
    return NARRATIVE_MEMORY_READ_DESCRIPTOR;
  }
  if (NARRATIVE_MEMORY_MEMORY_WRITE_ACTIONS.has(action)) {
    return NARRATIVE_MEMORY_MEMORY_WRITE_DESCRIPTOR;
  }
  if (action === "promote") {
    return NARRATIVE_MEMORY_PROMOTE_DESCRIPTOR;
  }
  return NARRATIVE_MEMORY_DEFAULT_DESCRIPTOR;
}

const EXACT_TOOL_GOVERNANCE_RESOLVERS_BY_NAME: Record<string, ToolGovernanceResolver> = {
  narrative_memory: resolveNarrativeMemoryDescriptor,
};

export const TOOL_GOVERNANCE_BY_NAME: Record<string, ToolGovernanceDescriptor> = {
  read: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  write: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  edit: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  grep: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  git_status: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
    boundary: "safe",
    rollbackable: false,
  }),
  git_diff: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
    boundary: "safe",
    rollbackable: false,
  }),
  git_log: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
    boundary: "safe",
    rollbackable: false,
  }),
  glob: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  read_spans: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  look_at: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  toc_document: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  toc_search: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  ast_grep_search: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  ast_grep_replace: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  lsp_diagnostics: descriptor({
    effects: ["workspace_read", "runtime_observe"],
    defaultRisk: "low",
  }),
  lsp_find_references: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_goto_definition: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_prepare_rename: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_rename: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  lsp_symbols: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  output_search: descriptor({
    effects: ["workspace_read", "runtime_observe"],
    defaultRisk: "low",
  }),
  workflow_status: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  iteration_fact: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  ledger_query: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_handoff: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_info: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_search: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  resource_lease: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  session_compact: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  cost_view: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  deliberation_memory: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  narrative_memory: NARRATIVE_MEMORY_DEFAULT_DESCRIPTOR,
  knowledge_capture: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  knowledge_search: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  precedent_audit: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  precedent_sweep: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  obs_query: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  obs_slo_assert: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  obs_snapshot: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  optimization_continuity: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  exec: descriptor({
    effects: ["local_exec"],
    defaultRisk: "high",
  }),
  browser_open: descriptor({
    effects: ["local_exec"],
    defaultRisk: "medium",
  }),
  browser_wait: descriptor({
    effects: ["local_exec"],
    defaultRisk: "low",
  }),
  browser_snapshot: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "medium",
  }),
  browser_click: descriptor({
    effects: ["local_exec"],
    defaultRisk: "high",
  }),
  browser_fill: descriptor({
    effects: ["local_exec"],
    defaultRisk: "high",
  }),
  browser_get: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "medium",
  }),
  browser_screenshot: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "medium",
  }),
  browser_pdf: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "medium",
  }),
  browser_diff_snapshot: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "medium",
  }),
  browser_state_load: descriptor({
    effects: ["workspace_read", "local_exec"],
    defaultRisk: "high",
  }),
  browser_state_save: descriptor({
    effects: ["local_exec", "workspace_write"],
    defaultRisk: "high",
  }),
  browser_close: descriptor({
    effects: ["local_exec"],
    defaultRisk: "low",
  }),
  process: descriptor({
    effects: ["local_exec"],
    defaultRisk: "medium",
  }),
  schedule_intent: descriptor({
    effects: ["schedule_mutation"],
    defaultRisk: "high",
  }),
  skill_load: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  skill_complete: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  skill_promotion: descriptor({
    effects: ["memory_write", "workspace_write"],
    defaultRisk: "medium",
  }),
  worker_results_merge: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  worker_results_apply: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  subagent_run: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  subagent_fanout: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  subagent_status: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  subagent_cancel: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  task_view_state: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  task_set_spec: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_add_item: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_update_item: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_record_blocker: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_record_acceptance: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
    rollbackable: false,
  }),
  task_resolve_blocker: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  rollback_last_patch: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  agent_send: descriptor({
    effects: ["external_network", "external_side_effect"],
    defaultRisk: "high",
  }),
  agent_broadcast: descriptor({
    effects: ["external_network", "external_side_effect"],
    defaultRisk: "high",
  }),
  agent_list: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
};

const TOOL_NAME_EFFECT_HINTS: Array<{
  match: RegExp;
  descriptor: ToolGovernanceDescriptor;
}> = [
  {
    match: /(^|_)(read|view|search|grep|find|inspect|query|list|show|diag|symbol)(_|$)/u,
    descriptor: descriptor({
      effects: ["workspace_read"],
      defaultRisk: "low",
    }),
  },
  {
    match: /(^|_)(edit|write|patch|rename|replace|apply)(_|$)/u,
    descriptor: descriptor({
      effects: ["workspace_write"],
      defaultRisk: "high",
    }),
  },
  {
    match: /(^|_)(exec|shell|bash|command)(_|$)/u,
    descriptor: descriptor({
      effects: ["local_exec"],
      defaultRisk: "high",
    }),
  },
];

function validateToolGovernanceDescriptor(
  toolName: string,
  input: ToolGovernanceDescriptor,
): ToolGovernanceDescriptor {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    throw new Error("tool governance descriptor requires a non-empty tool name");
  }
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw new Error(`tool governance descriptor '${normalized}' requires at least one effect`);
  }
  const normalizedDescriptor = normalizeDescriptor(input);
  assertToolGovernanceInvariants(normalized, normalizedDescriptor);
  return normalizedDescriptor;
}

export class ToolGovernanceRegistry {
  private readonly customByName = new Map<string, ToolGovernanceDescriptor>();
  private readonly customResolversByName = new Map<string, ToolGovernanceResolver>();

  register(toolName: string, input: ToolGovernanceDescriptor): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      throw new Error("tool governance descriptor requires a non-empty tool name");
    }
    this.customByName.set(normalized, validateToolGovernanceDescriptor(normalized, input));
  }

  registerResolver(toolName: string, resolver: ToolGovernanceResolver): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      throw new Error("tool governance resolver requires a non-empty tool name");
    }
    this.customResolversByName.set(normalized, resolver);
  }

  unregister(toolName: string): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) return;
    this.customByName.delete(normalized);
    this.customResolversByName.delete(normalized);
  }

  get(toolName: string, args?: Record<string, unknown>): ToolGovernanceDescriptor | undefined {
    return this.resolve(toolName, args).descriptor;
  }

  resolve(toolName: string, args?: Record<string, unknown>): ToolGovernanceResolution {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      return {
        source: "missing",
      };
    }
    const customResolver = this.customResolversByName.get(normalized);
    if (customResolver) {
      const resolved = customResolver({ toolName: normalized, args });
      if (resolved) {
        return {
          descriptor: validateToolGovernanceDescriptor(normalized, resolved),
          source: "registry",
        };
      }
    }
    const custom = this.customByName.get(normalized);
    if (custom) {
      return {
        descriptor: custom,
        source: "registry",
      };
    }
    return resolveDescriptorWithoutCustom(normalized, args);
  }
}

export function createToolGovernanceRegistry(): ToolGovernanceRegistry {
  return new ToolGovernanceRegistry();
}

export function getExactToolGovernanceDescriptor(
  toolName: string,
): ToolGovernanceDescriptor | undefined {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return undefined;
  return TOOL_GOVERNANCE_BY_NAME[normalized];
}

export function sameToolGovernanceDescriptor(
  left: ToolGovernanceDescriptor | undefined,
  right: ToolGovernanceDescriptor | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.defaultRisk === right.defaultRisk &&
    left.boundary === right.boundary &&
    left.rollbackable === right.rollbackable &&
    sameEffects(left.effects, right.effects)
  );
}

function resolveDescriptorWithoutCustom(
  toolName: string,
  args?: Record<string, unknown>,
): ToolGovernanceResolution {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return {
      source: "missing",
    };
  }
  const exactResolver = EXACT_TOOL_GOVERNANCE_RESOLVERS_BY_NAME[normalized];
  if (exactResolver) {
    const resolved = exactResolver({ toolName: normalized, args });
    if (resolved) {
      return {
        descriptor: validateToolGovernanceDescriptor(normalized, resolved),
        source: "exact",
      };
    }
  }
  const exact = getExactToolGovernanceDescriptor(normalized);
  if (exact) {
    return {
      descriptor: exact,
      source: "exact",
    };
  }
  const hinted = TOOL_NAME_EFFECT_HINTS.find((entry) => entry.match.test(normalized));
  if (hinted) {
    return {
      descriptor: hinted.descriptor,
      source: "hint",
    };
  }
  return {
    source: "missing",
  };
}

export function getToolGovernanceDescriptor(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "get">,
  args?: Record<string, unknown>,
): ToolGovernanceDescriptor | undefined {
  return registry
    ? registry.get(toolName, args)
    : resolveDescriptorWithoutCustom(toolName, args).descriptor;
}

export function getToolGovernanceResolution(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "resolve">,
  args?: Record<string, unknown>,
): ToolGovernanceResolution {
  return registry
    ? registry.resolve(toolName, args)
    : resolveDescriptorWithoutCustom(toolName, args);
}

function assertToolGovernanceInvariants(
  toolName: string,
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): void {
  if (!toolDescriptor) {
    return;
  }
  const requiresApproval = toolGovernanceRequiresEffectCommitment(toolDescriptor);
  if (toolDescriptor.rollbackable === true && !toolDescriptor.effects.includes("workspace_write")) {
    throw new Error(
      `tool_governance_invariant_violated:${normalizeToolName(toolName)} rollbackable tools require workspace_write`,
    );
  }
  if (toolDescriptor.rollbackable === true && requiresApproval) {
    throw new Error(
      `tool_governance_invariant_violated:${normalizeToolName(toolName)} cannot explicitly opt into rollback while requiring approval`,
    );
  }
  const rollbackable = toolGovernanceCreatesRollbackAnchor(toolDescriptor);
  if (requiresApproval && rollbackable) {
    throw new Error(
      `tool_governance_invariant_violated:${normalizeToolName(toolName)} cannot be both approval_bound and rollbackable`,
    );
  }
}

function resolveAuthorityFromResolution(
  toolName: string,
  resolution: ToolGovernanceResolution,
): ResolvedToolAuthority {
  const normalizedToolName = normalizeToolName(toolName);
  const resolvedDescriptor = resolution.descriptor;
  assertToolGovernanceInvariants(normalizedToolName, resolvedDescriptor);
  return {
    normalizedToolName,
    descriptor: resolvedDescriptor,
    source: resolution.source,
    boundary: resolvedDescriptor?.boundary ?? "effectful",
    requiresApproval: toolGovernanceRequiresEffectCommitment(resolvedDescriptor),
    rollbackable: toolGovernanceCreatesRollbackAnchor(resolvedDescriptor),
  };
}

export function resolveToolAuthority(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "resolve">,
  args?: Record<string, unknown>,
): ResolvedToolAuthority {
  return resolveAuthorityFromResolution(
    toolName,
    getToolGovernanceResolution(toolName, registry, args),
  );
}

export function resolveToolExecutionBoundary(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "resolve">,
  args?: Record<string, unknown>,
): ToolExecutionBoundary {
  return resolveToolAuthority(toolName, registry, args).boundary;
}

export function toolGovernanceRequiresEffectCommitment(
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): boolean {
  return toolEffectsRequireEffectCommitment(toolDescriptor?.effects ?? []);
}

export function toolGovernanceCreatesRollbackAnchor(
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): boolean {
  if (toolDescriptor?.rollbackable === false) {
    return false;
  }
  return toolEffectsCreateRollbackAnchor(toolDescriptor?.effects ?? []);
}
