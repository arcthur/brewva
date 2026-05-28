import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import type { ShellCockpitComposerPolicy, ShellCockpitDecisionItem } from "./types.js";

export function resolveShellCockpitComposerPolicy(input: {
  readonly phase: SessionPhase;
  readonly activeDecision?: ShellCockpitDecisionItem;
  readonly costStatus: RuntimeCostPosture["status"];
}): ShellCockpitComposerPolicy {
  switch (input.phase.kind) {
    case "model_streaming":
    case "tool_executing":
      return "queue";
    case "waiting_approval":
    case "crashed":
      return "stash";
    case "recovering":
    case "terminated":
      return "block";
    case "idle":
      break;
  }

  if (input.activeDecision || input.costStatus === "blocked") {
    return "stash";
  }
  return "active";
}

export function resolveShellCockpitComposerPolicyForPhase(
  phase: SessionPhase,
): ShellCockpitComposerPolicy {
  switch (phase.kind) {
    case "model_streaming":
    case "tool_executing":
      return "queue";
    case "waiting_approval":
    case "crashed":
      return "stash";
    case "recovering":
    case "terminated":
      return "block";
    case "idle":
      return "active";
  }
  return "active";
}

const COMPOSER_POLICY_WEIGHT: Record<ShellCockpitComposerPolicy, number> = {
  active: 0,
  queue: 1,
  muted: 2,
  stash: 3,
  block: 4,
};

export function resolveShellCockpitComposerSubmitPolicy(input: {
  readonly phase: SessionPhase;
  readonly projectionPolicy?: ShellCockpitComposerPolicy;
}): ShellCockpitComposerPolicy {
  const projectionPolicy = input.projectionPolicy ?? "active";
  const phasePolicy = resolveShellCockpitComposerPolicyForPhase(input.phase);
  return COMPOSER_POLICY_WEIGHT[phasePolicy] > COMPOSER_POLICY_WEIGHT[projectionPolicy]
    ? phasePolicy
    : projectionPolicy;
}

export function shellCockpitComposerPolicyAllowsSubmit(
  policy: ShellCockpitComposerPolicy,
): boolean {
  return policy === "active" || policy === "queue";
}

export function shellCockpitComposerPolicyBlocksMutation(
  policy: ShellCockpitComposerPolicy,
): boolean {
  return policy === "block";
}

export function describeShellCockpitComposerPolicyBlock(
  policy: ShellCockpitComposerPolicy,
): string | undefined {
  switch (policy) {
    case "active":
    case "queue":
      return undefined;
    case "muted":
      return "Composer is muted while the current turn is active. Keep drafting, then submit when the turn settles.";
    case "stash":
      return "Decision lane owns the next action. Your draft is preserved; resolve the active decision before submitting.";
    case "block":
      return "Composer is blocked for this session phase. Resolve recovery or open a new session before editing.";
  }
  return undefined;
}
