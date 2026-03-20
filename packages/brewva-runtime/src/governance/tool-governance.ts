import type {
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolGovernanceRisk,
} from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

function descriptor(input: {
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  boundary?: ToolExecutionBoundary;
}): ToolGovernanceDescriptor {
  return {
    effects: input.effects,
    defaultRisk: input.defaultRisk,
    boundary: input.boundary ?? resolveToolExecutionBoundaryFromEffects(input.effects),
  };
}

function normalizeDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
    boundary: input.boundary ?? resolveToolExecutionBoundaryFromEffects(input.effects),
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
  return (
    !toolEffectsRequireEffectCommitment(effects) &&
    effects.some((effect) => effect === "workspace_write" || effect === "memory_write")
  );
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
  exec: descriptor({
    effects: ["local_exec"],
    defaultRisk: "high",
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
  return normalizeDescriptor(input);
}

export class ToolGovernanceRegistry {
  private readonly customByName = new Map<string, ToolGovernanceDescriptor>();

  register(toolName: string, input: ToolGovernanceDescriptor): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      throw new Error("tool governance descriptor requires a non-empty tool name");
    }
    this.customByName.set(normalized, validateToolGovernanceDescriptor(normalized, input));
  }

  unregister(toolName: string): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) return;
    this.customByName.delete(normalized);
  }

  get(toolName: string): ToolGovernanceDescriptor | undefined {
    return this.resolve(toolName).descriptor;
  }

  resolve(toolName: string): ToolGovernanceResolution {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      return {
        source: "missing",
      };
    }
    const custom = this.customByName.get(normalized);
    if (custom) {
      return {
        descriptor: custom,
        source: "registry",
      };
    }
    return resolveDescriptorWithoutCustom(normalized);
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
    sameEffects(left.effects, right.effects)
  );
}

export type ToolGovernanceDescriptorSource = "registry" | "exact" | "hint" | "missing";

export interface ToolGovernanceResolution {
  descriptor?: ToolGovernanceDescriptor;
  source: ToolGovernanceDescriptorSource;
}

function resolveDescriptorWithoutCustom(toolName: string): ToolGovernanceResolution {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return {
      source: "missing",
    };
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
): ToolGovernanceDescriptor | undefined {
  return registry ? registry.get(toolName) : resolveDescriptorWithoutCustom(toolName).descriptor;
}

export function getToolGovernanceResolution(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "resolve">,
): ToolGovernanceResolution {
  return registry ? registry.resolve(toolName) : resolveDescriptorWithoutCustom(toolName);
}

export function resolveToolExecutionBoundary(
  toolName: string,
  registry?: Pick<ToolGovernanceRegistry, "get">,
): ToolExecutionBoundary {
  return getToolGovernanceDescriptor(toolName, registry)?.boundary ?? "safe";
}

export function toolGovernanceRequiresEffectCommitment(
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): boolean {
  return toolEffectsRequireEffectCommitment(toolDescriptor?.effects ?? []);
}

export function toolGovernanceCreatesRollbackAnchor(
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): boolean {
  return toolEffectsCreateRollbackAnchor(toolDescriptor?.effects ?? []);
}
