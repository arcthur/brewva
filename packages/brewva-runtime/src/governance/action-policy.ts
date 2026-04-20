import type {
  EffectiveToolActionPolicy,
  SkillRoutingScope,
  ToolActionClass,
  ToolActionPolicy,
  ToolActionPolicyResolver,
  ToolActionPolicyResolverInput,
  ToolAdmissionBehavior,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolRiskLevel,
} from "../contracts/index.js";
import { normalizeToolName } from "../utils/tool-name.js";

type ToolActionPolicyInput = {
  actionClass: ToolActionClass;
  riskLevel: ToolRiskLevel;
  defaultAdmission: ToolAdmissionBehavior;
  maxAdmission: ToolAdmissionBehavior;
  receiptPolicy: ToolActionPolicy["receiptPolicy"];
  recoveryPolicy: ToolActionPolicy["recoveryPolicy"];
  effectClasses: readonly ToolEffectClass[];
  sandboxPolicy?: ToolActionPolicy["sandboxPolicy"];
  budgetWeight?: number;
  requiredRoutingScopes?: readonly SkillRoutingScope[];
  safetyGate?: ToolActionPolicy["safetyGate"];
};

export type ToolActionPolicySource = "registry" | "exact" | "hint" | "missing";

export interface ToolActionPolicyResolution {
  policy?: ToolActionPolicy;
  source: ToolActionPolicySource;
}

const ADMISSION_RANK: Record<ToolAdmissionBehavior, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const TOOL_ACTION_CLASS_VALUES = [
  "workspace_read",
  "runtime_observe",
  "workspace_patch",
  "memory_write",
  "control_state_mutation",
  "budget_mutation",
  "local_exec_readonly",
  "local_exec_effectful",
  "external_side_effect",
  "schedule_mutation",
  "delegation",
  "credential_access",
] as const satisfies readonly ToolActionClass[];

type MissingToolActionClass = Exclude<ToolActionClass, (typeof TOOL_ACTION_CLASS_VALUES)[number]>;
const TOOL_ACTION_CLASS_EXHAUSTIVE_CHECK: Record<MissingToolActionClass, never> = {};
void TOOL_ACTION_CLASS_EXHAUSTIVE_CHECK;

const TOOL_ADMISSION_BEHAVIOR_VALUES = [
  "allow",
  "ask",
  "deny",
] as const satisfies readonly ToolAdmissionBehavior[];

type MissingToolAdmissionBehavior = Exclude<
  ToolAdmissionBehavior,
  (typeof TOOL_ADMISSION_BEHAVIOR_VALUES)[number]
>;
const TOOL_ADMISSION_BEHAVIOR_EXHAUSTIVE_CHECK: Record<MissingToolAdmissionBehavior, never> = {};
void TOOL_ADMISSION_BEHAVIOR_EXHAUSTIVE_CHECK;

export const TOOL_ACTION_CLASSES = TOOL_ACTION_CLASS_VALUES;
export const TOOL_ADMISSION_BEHAVIORS = TOOL_ADMISSION_BEHAVIOR_VALUES;

function uniqueValues<T>(values: readonly T[] | undefined): T[] | undefined {
  return values ? [...new Set(values)] : undefined;
}

function buildPolicy(input: ToolActionPolicyInput): ToolActionPolicy {
  return validateToolActionPolicy(input.actionClass, {
    actionClass: input.actionClass,
    riskLevel: input.riskLevel,
    defaultAdmission: input.defaultAdmission,
    maxAdmission: input.maxAdmission,
    receiptPolicy: input.receiptPolicy,
    recoveryPolicy: input.recoveryPolicy,
    effectClasses: [...new Set(input.effectClasses)],
    sandboxPolicy: input.sandboxPolicy,
    budgetWeight: input.budgetWeight,
    requiredRoutingScopes: uniqueValues(input.requiredRoutingScopes),
    safetyGate: input.safetyGate,
  });
}

function readActionArgument(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const value = args.action;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function workspaceRead(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "workspace_read",
    riskLevel: "low",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "audit", required: false },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["workspace_read"],
  });
}

function runtimeObserve(riskLevel: ToolRiskLevel = "low"): ToolActionPolicy {
  return buildPolicy({
    actionClass: "runtime_observe",
    riskLevel,
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "audit", required: false },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["runtime_observe"],
  });
}

function workspacePatch(riskLevel: ToolRiskLevel = "high"): ToolActionPolicy {
  return buildPolicy({
    actionClass: "workspace_patch",
    riskLevel,
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "mutation", required: true },
    recoveryPolicy: { kind: "exact_patch", strategy: "workspace_patchset" },
    effectClasses: ["workspace_write"],
  });
}

function memoryWrite(
  input: {
    effectClasses?: readonly ToolEffectClass[];
    requiredRoutingScopes?: readonly SkillRoutingScope[];
  } = {},
): ToolActionPolicy {
  return buildPolicy({
    actionClass: "memory_write",
    riskLevel: "medium",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "control_plane", required: true },
    recoveryPolicy: { kind: "none" },
    effectClasses: input.effectClasses ?? ["memory_write"],
    requiredRoutingScopes: input.requiredRoutingScopes,
  });
}

function controlStateMutation(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "control_state_mutation",
    riskLevel: "medium",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "control_plane", required: true },
    recoveryPolicy: { kind: "forward_correction" },
    effectClasses: ["control_state_mutation"],
  });
}

function budgetMutation(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "budget_mutation",
    riskLevel: "medium",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "control_plane", required: true },
    recoveryPolicy: { kind: "compensation", mode: "async_cancel" },
    effectClasses: ["budget_mutation"],
  });
}

function localExecEffectful(
  input: {
    riskLevel?: ToolRiskLevel;
    effectClasses?: readonly ToolEffectClass[];
    recoveryPolicy?: ToolActionPolicy["recoveryPolicy"];
  } = {},
): ToolActionPolicy {
  return buildPolicy({
    actionClass: "local_exec_effectful",
    riskLevel: input.riskLevel ?? "high",
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "commitment", required: true },
    recoveryPolicy: input.recoveryPolicy ?? { kind: "manual_recovery_evidence" },
    effectClasses: input.effectClasses ?? ["local_exec"],
    sandboxPolicy: { kind: "host_effect" },
  });
}

function localExecReadonly(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "local_exec_readonly",
    riskLevel: "medium",
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "execution", required: true },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["local_exec"],
    sandboxPolicy: { kind: "sandbox_required" },
    safetyGate: {
      localExecReadonlyAutoAllow: false,
      reason: "command_policy_and_sandbox_not_implemented",
    },
  });
}

function externalSideEffect(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "external_side_effect",
    riskLevel: "high",
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "commitment", required: true },
    recoveryPolicy: { kind: "manual_recovery_evidence" },
    effectClasses: ["external_network", "external_side_effect"],
  });
}

function scheduleMutation(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "schedule_mutation",
    riskLevel: "high",
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "commitment", required: true },
    recoveryPolicy: { kind: "compensation", mode: "async_cancel" },
    effectClasses: ["schedule_mutation"],
  });
}

function delegation(riskLevel: ToolRiskLevel = "medium"): ToolActionPolicy {
  return buildPolicy({
    actionClass: "delegation",
    riskLevel,
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "delegation", required: true },
    recoveryPolicy: { kind: "none", scope: "parent_delegation" },
    effectClasses: ["delegation"],
  });
}

function credentialAccess(): ToolActionPolicy {
  return buildPolicy({
    actionClass: "credential_access",
    riskLevel: "critical",
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "security_audit", required: true },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["credential_access"],
  });
}

const TOOL_ACTION_POLICY_BY_CLASS: Record<ToolActionClass, ToolActionPolicy> = {
  workspace_read: workspaceRead(),
  runtime_observe: runtimeObserve(),
  workspace_patch: workspacePatch(),
  memory_write: memoryWrite(),
  control_state_mutation: controlStateMutation(),
  budget_mutation: budgetMutation(),
  local_exec_readonly: localExecReadonly(),
  local_exec_effectful: localExecEffectful(),
  external_side_effect: externalSideEffect(),
  schedule_mutation: scheduleMutation(),
  delegation: delegation(),
  credential_access: credentialAccess(),
};

const NARRATIVE_MEMORY_READ_ACTIONS = new Set(["list", "show", "retrieve", "stats"]);
const NARRATIVE_MEMORY_MEMORY_WRITE_ACTIONS = new Set(["remember", "review", "archive", "forget"]);

const NARRATIVE_MEMORY_DEFAULT_POLICY = memoryWrite({
  effectClasses: ["runtime_observe", "memory_write", "workspace_write"],
});
const NARRATIVE_MEMORY_READ_POLICY = runtimeObserve("low");
const NARRATIVE_MEMORY_MEMORY_WRITE_POLICY = memoryWrite();
const NARRATIVE_MEMORY_PROMOTE_POLICY = memoryWrite({
  effectClasses: ["memory_write", "workspace_write"],
});

function resolveNarrativeMemoryPolicy(
  input: ToolActionPolicyResolverInput,
): ToolActionPolicy | undefined {
  if (normalizeToolName(input.toolName) !== "narrative_memory") return undefined;
  const action = readActionArgument(input.args);
  if (!action) return NARRATIVE_MEMORY_DEFAULT_POLICY;
  if (NARRATIVE_MEMORY_READ_ACTIONS.has(action)) return NARRATIVE_MEMORY_READ_POLICY;
  if (NARRATIVE_MEMORY_MEMORY_WRITE_ACTIONS.has(action)) {
    return NARRATIVE_MEMORY_MEMORY_WRITE_POLICY;
  }
  if (action === "promote") return NARRATIVE_MEMORY_PROMOTE_POLICY;
  return NARRATIVE_MEMORY_DEFAULT_POLICY;
}

const EXACT_TOOL_ACTION_POLICY_RESOLVERS_BY_NAME: Record<string, ToolActionPolicyResolver> = {
  narrative_memory: resolveNarrativeMemoryPolicy,
};

export const TOOL_ACTION_POLICY_BY_NAME: Record<string, ToolActionPolicy> = {
  read: workspaceRead(),
  write: workspacePatch(),
  edit: workspacePatch(),
  grep: workspaceRead(),
  git_status: workspaceRead(),
  git_diff: workspaceRead(),
  git_log: workspaceRead(),
  glob: workspaceRead(),
  read_spans: workspaceRead(),
  look_at: workspaceRead(),
  toc_document: workspaceRead(),
  toc_search: workspaceRead(),
  ast_grep_search: workspaceRead(),
  ast_grep_replace: workspacePatch(),
  lsp_diagnostics: buildPolicy({
    actionClass: "workspace_read",
    riskLevel: "low",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "audit", required: false },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["workspace_read", "runtime_observe"],
  }),
  lsp_find_references: workspaceRead(),
  lsp_goto_definition: workspaceRead(),
  lsp_prepare_rename: workspaceRead(),
  lsp_rename: workspacePatch(),
  lsp_symbols: workspaceRead(),
  output_search: buildPolicy({
    actionClass: "workspace_read",
    riskLevel: "low",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "audit", required: false },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["workspace_read", "runtime_observe"],
  }),
  workflow_status: runtimeObserve(),
  iteration_fact: memoryWrite(),
  ledger_query: runtimeObserve(),
  tape_handoff: controlStateMutation(),
  tape_info: runtimeObserve(),
  tape_search: runtimeObserve(),
  resource_lease: budgetMutation(),
  reasoning_checkpoint: controlStateMutation(),
  reasoning_revert: controlStateMutation(),
  session_compact: controlStateMutation(),
  cost_view: runtimeObserve(),
  deliberation_memory: runtimeObserve(),
  narrative_memory: NARRATIVE_MEMORY_DEFAULT_POLICY,
  knowledge_capture: workspacePatch(),
  recall_search: buildPolicy({
    actionClass: "workspace_read",
    riskLevel: "low",
    defaultAdmission: "allow",
    maxAdmission: "allow",
    receiptPolicy: { kind: "audit", required: false },
    recoveryPolicy: { kind: "none" },
    effectClasses: ["workspace_read", "runtime_observe"],
  }),
  recall_curate: memoryWrite({ requiredRoutingScopes: ["operator", "meta"] }),
  knowledge_search: workspaceRead(),
  precedent_audit: workspaceRead(),
  precedent_sweep: workspaceRead(),
  obs_query: runtimeObserve(),
  obs_slo_assert: runtimeObserve(),
  obs_snapshot: runtimeObserve(),
  optimization_continuity: runtimeObserve(),
  exec: localExecEffectful(),
  local_exec_readonly: localExecReadonly(),
  browser_open: localExecEffectful({ riskLevel: "medium" }),
  browser_wait: localExecEffectful({ riskLevel: "low" }),
  browser_snapshot: localExecEffectful({
    riskLevel: "medium",
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_click: localExecEffectful(),
  browser_fill: localExecEffectful(),
  browser_get: localExecEffectful({
    riskLevel: "medium",
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_screenshot: localExecEffectful({
    riskLevel: "medium",
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_pdf: localExecEffectful({
    riskLevel: "medium",
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_diff_snapshot: localExecEffectful({
    riskLevel: "medium",
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_state_load: localExecEffectful({
    effectClasses: ["workspace_read", "local_exec"],
  }),
  browser_state_save: localExecEffectful({
    effectClasses: ["local_exec", "workspace_write"],
    recoveryPolicy: { kind: "artifact_cleanup" },
  }),
  browser_close: localExecEffectful({ riskLevel: "low" }),
  process: localExecEffectful({ riskLevel: "medium" }),
  schedule_intent: scheduleMutation(),
  follow_up: scheduleMutation(),
  skill_load: controlStateMutation(),
  skill_complete: controlStateMutation(),
  skill_promotion: memoryWrite({ effectClasses: ["memory_write", "workspace_write"] }),
  worker_results_merge: runtimeObserve(),
  worker_results_apply: workspacePatch(),
  subagent_run: delegation(),
  subagent_fanout: delegation(),
  subagent_status: delegation("low"),
  subagent_cancel: delegation(),
  task_view_state: runtimeObserve(),
  task_set_spec: memoryWrite(),
  task_add_item: memoryWrite(),
  task_update_item: memoryWrite(),
  task_record_blocker: memoryWrite(),
  task_record_acceptance: memoryWrite(),
  task_resolve_blocker: memoryWrite(),
  rollback_last_patch: workspacePatch(),
  agent_send: externalSideEffect(),
  agent_broadcast: externalSideEffect(),
  agent_list: runtimeObserve(),
  credential_access: credentialAccess(),
};

const TOOL_NAME_ACTION_POLICY_HINTS: Array<{
  match: RegExp;
  policy: ToolActionPolicy;
}> = [
  {
    match: /(^|_)(read|view|search|grep|find|inspect|query|list|show|diag|symbol)(_|$)/u,
    policy: workspaceRead(),
  },
  {
    match: /(^|_)(edit|write|patch|rename|replace|apply)(_|$)/u,
    policy: workspacePatch(),
  },
  {
    match: /(^|_)(exec|shell|bash|command)(_|$)/u,
    policy: localExecEffectful(),
  },
];

export function compareToolAdmission(
  left: ToolAdmissionBehavior,
  right: ToolAdmissionBehavior,
): number {
  return ADMISSION_RANK[left] - ADMISSION_RANK[right];
}

function clonePolicy(input: ToolActionPolicy): ToolActionPolicy {
  return {
    ...input,
    effectClasses: [...new Set(input.effectClasses)],
    requiredRoutingScopes: input.requiredRoutingScopes
      ? [...new Set(input.requiredRoutingScopes)]
      : undefined,
    receiptPolicy: { ...input.receiptPolicy },
    recoveryPolicy: { ...input.recoveryPolicy },
    sandboxPolicy: input.sandboxPolicy ? { ...input.sandboxPolicy } : undefined,
    safetyGate: input.safetyGate ? { ...input.safetyGate } : undefined,
  };
}

function sameValues<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  const leftValues = [...new Set(left ?? [])].toSorted((leftValue, rightValue) =>
    leftValue.localeCompare(rightValue),
  );
  const rightValues = [...new Set(right ?? [])].toSorted((leftValue, rightValue) =>
    leftValue.localeCompare(rightValue),
  );
  if (leftValues.length !== rightValues.length) return false;
  return leftValues.every((value, index) => value === rightValues[index]);
}

function samePrimitiveRecord(left: object | undefined, right: object | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEntries = Object.entries(left)
    .filter(([, value]) => value !== undefined)
    .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right)
    .filter(([, value]) => value !== undefined)
    .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index] ?? [];
    return key === rightKey && Object.is(value, rightValue);
  });
}

export function validateToolActionPolicy(
  toolName: string,
  input: ToolActionPolicy,
): ToolActionPolicy {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    throw new Error("tool action policy requires a non-empty tool name");
  }
  if (!Array.isArray(input.effectClasses) || input.effectClasses.length === 0) {
    throw new Error(`tool action policy '${normalized}' requires at least one effect class`);
  }
  if (input.riskLevel === "critical" && compareToolAdmission(input.maxAdmission, "ask") < 0) {
    throw new Error(
      `tool_action_policy_invariant_violated:${normalized} critical action policy cannot be relaxed below ask`,
    );
  }
  if (compareToolAdmission(input.defaultAdmission, input.maxAdmission) < 0) {
    throw new Error(
      `tool_action_policy_invariant_violated:${normalized} default admission cannot be less restrictive than max admission`,
    );
  }
  return clonePolicy(input);
}

export function getToolActionClassAdmissionBounds(actionClass: ToolActionClass): {
  riskLevel: ToolRiskLevel;
  maxAdmission: ToolAdmissionBehavior;
} {
  const policy = TOOL_ACTION_POLICY_BY_CLASS[actionClass];
  return {
    riskLevel: policy.riskLevel,
    maxAdmission: policy.maxAdmission,
  };
}

export function resolveEffectiveToolActionPolicy(
  policy: ToolActionPolicy,
  override?: ToolAdmissionBehavior,
): EffectiveToolActionPolicy {
  const requested = override ?? policy.defaultAdmission;
  const tooRelaxed = compareToolAdmission(requested, policy.maxAdmission) < 0;
  const criticalTooRelaxed =
    policy.riskLevel === "critical" && compareToolAdmission(requested, "ask") < 0;
  const effectiveAdmission = tooRelaxed || criticalTooRelaxed ? policy.maxAdmission : requested;
  return {
    ...clonePolicy(policy),
    effectiveAdmission,
  };
}

export function deriveToolGovernanceDescriptor(policy: ToolActionPolicy): ToolGovernanceDescriptor {
  const effects = [...new Set(policy.effectClasses)];
  const boundary = effects.some(
    (effect) => effect !== "workspace_read" && effect !== "runtime_observe",
  )
    ? "effectful"
    : "safe";
  const descriptor: ToolGovernanceDescriptor = {
    effects,
    defaultRisk: policy.riskLevel,
    boundary,
  };
  if (policy.recoveryPolicy.kind !== "exact_patch") {
    descriptor.rollbackable = false;
  }
  if (policy.requiredRoutingScopes && policy.requiredRoutingScopes.length > 0) {
    descriptor.requiredRoutingScopes = [...new Set(policy.requiredRoutingScopes)];
  }
  return descriptor;
}

export function toolActionPolicyRequiresApproval(
  policy: EffectiveToolActionPolicy | ToolActionPolicy,
): boolean {
  return "effectiveAdmission" in policy
    ? policy.effectiveAdmission === "ask"
    : policy.defaultAdmission === "ask";
}

export function toolActionPolicyCreatesRollbackAnchor(policy: ToolActionPolicy): boolean {
  return policy.recoveryPolicy.kind === "exact_patch";
}

export class ActionPolicyRegistry {
  private readonly customByName = new Map<string, ToolActionPolicy>();
  private readonly customResolversByName = new Map<string, ToolActionPolicyResolver>();

  register(toolName: string, input: ToolActionPolicy): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      throw new Error("tool action policy requires a non-empty tool name");
    }
    this.customByName.set(normalized, validateToolActionPolicy(normalized, input));
  }

  registerResolver(toolName: string, resolver: ToolActionPolicyResolver): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      throw new Error("tool action policy resolver requires a non-empty tool name");
    }
    this.customResolversByName.set(normalized, resolver);
  }

  unregister(toolName: string): void {
    const normalized = normalizeToolName(toolName);
    if (!normalized) return;
    this.customByName.delete(normalized);
    this.customResolversByName.delete(normalized);
  }

  get(toolName: string, args?: Record<string, unknown>): ToolActionPolicy | undefined {
    return this.resolve(toolName, args).policy;
  }

  resolve(toolName: string, args?: Record<string, unknown>): ToolActionPolicyResolution {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      return { source: "missing" };
    }
    const customResolver = this.customResolversByName.get(normalized);
    if (customResolver) {
      const resolved = customResolver({ toolName: normalized, args });
      if (resolved) {
        return {
          policy: validateToolActionPolicy(normalized, resolved),
          source: "registry",
        };
      }
    }
    const custom = this.customByName.get(normalized);
    if (custom) {
      return {
        policy: custom,
        source: "registry",
      };
    }
    return resolveActionPolicyWithoutCustom(normalized, args);
  }
}

export function createActionPolicyRegistry(): ActionPolicyRegistry {
  return new ActionPolicyRegistry();
}

export function getExactToolActionPolicy(toolName: string): ToolActionPolicy | undefined {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return undefined;
  const resolver = EXACT_TOOL_ACTION_POLICY_RESOLVERS_BY_NAME[normalized];
  if (resolver) {
    const resolved = resolver({ toolName: normalized });
    return resolved ? validateToolActionPolicy(normalized, resolved) : undefined;
  }
  const exact = TOOL_ACTION_POLICY_BY_NAME[normalized];
  return exact ? validateToolActionPolicy(normalized, exact) : undefined;
}

function resolveActionPolicyWithoutCustom(
  toolName: string,
  args?: Record<string, unknown>,
): ToolActionPolicyResolution {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return { source: "missing" };
  const exactResolver = EXACT_TOOL_ACTION_POLICY_RESOLVERS_BY_NAME[normalized];
  if (exactResolver) {
    const resolved = exactResolver({ toolName: normalized, args });
    if (resolved) {
      return {
        policy: validateToolActionPolicy(normalized, resolved),
        source: "exact",
      };
    }
  }
  const exact = TOOL_ACTION_POLICY_BY_NAME[normalized];
  if (exact) {
    return {
      policy: validateToolActionPolicy(normalized, exact),
      source: "exact",
    };
  }
  const hinted = TOOL_NAME_ACTION_POLICY_HINTS.find((entry) => entry.match.test(normalized));
  if (hinted) {
    return {
      policy: validateToolActionPolicy(normalized, hinted.policy),
      source: "hint",
    };
  }
  return { source: "missing" };
}

export function getToolActionPolicy(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "get">,
  args?: Record<string, unknown>,
): ToolActionPolicy | undefined {
  return registry
    ? registry.get(toolName, args)
    : resolveActionPolicyWithoutCustom(toolName, args).policy;
}

export function getToolActionPolicyResolution(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "resolve">,
  args?: Record<string, unknown>,
): ToolActionPolicyResolution {
  return registry
    ? registry.resolve(toolName, args)
    : resolveActionPolicyWithoutCustom(toolName, args);
}

export function sameToolActionPolicy(
  left: ToolActionPolicy | undefined,
  right: ToolActionPolicy | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.actionClass === right.actionClass &&
    left.riskLevel === right.riskLevel &&
    left.defaultAdmission === right.defaultAdmission &&
    left.maxAdmission === right.maxAdmission &&
    samePrimitiveRecord(left.receiptPolicy, right.receiptPolicy) &&
    samePrimitiveRecord(left.recoveryPolicy, right.recoveryPolicy) &&
    sameValues(left.effectClasses, right.effectClasses) &&
    sameValues(left.requiredRoutingScopes, right.requiredRoutingScopes) &&
    samePrimitiveRecord(left.sandboxPolicy, right.sandboxPolicy) &&
    samePrimitiveRecord(left.safetyGate, right.safetyGate) &&
    left.budgetWeight === right.budgetWeight
  );
}

export function resolveToolExecutionBoundaryFromEffects(
  effects: readonly ToolEffectClass[],
): ToolExecutionBoundary {
  return effects.some((effect) => effect !== "workspace_read" && effect !== "runtime_observe")
    ? "effectful"
    : "safe";
}
