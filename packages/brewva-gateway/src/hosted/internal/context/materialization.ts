import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
} from "@brewva/brewva-runtime/context";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import {
  recordPromptStabilityEvidence,
  recordProviderCacheObservationEvidence,
} from "./evidence/context-evidence.js";
import type { HostedContextRenderResult } from "./hosted-context-blocks.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import { buildPromptStabilityObservation } from "./prompt-stability.js";

export type HostedContextSideEffect =
  | "usage_observed"
  | "compaction_nudge_rendered"
  | "hard_gate_telemetry_emitted"
  | "compaction_advisory_telemetry_emitted"
  | "context_composed_emitted"
  | "telemetry_emitted"
  | "prompt_stability_observed"
  | "provider_cache_observed"
  | "visible_read_state_remembered"
  | "capability_disclosure_rendered"
  | "workbench_context_rendered"
  | "delegation_outcome_surfaced";

export interface HostedContextSideEffectLedger {
  effects: HostedContextSideEffect[];
}

type HostedContextMaterializationSideEffect = Exclude<
  HostedContextSideEffect,
  "provider_cache_observed" | "visible_read_state_remembered"
>;

export interface HostedContextSideEffectPlanEntry {
  readonly effect: HostedContextMaterializationSideEffect;
}

export const HOSTED_CONTEXT_SIDE_EFFECT_ORDER = [
  "usage_observed",
  "hard_gate_telemetry_emitted",
  "compaction_advisory_telemetry_emitted",
  "compaction_nudge_rendered",
  "context_composed_emitted",
  "telemetry_emitted",
  "capability_disclosure_rendered",
  "workbench_context_rendered",
  "prompt_stability_observed",
  "provider_cache_observed",
  "visible_read_state_remembered",
  "delegation_outcome_surfaced",
] as const satisfies readonly HostedContextSideEffect[];

function getHostedContextEffectOrderIndex(effect: HostedContextMaterializationSideEffect): number {
  return HOSTED_CONTEXT_SIDE_EFFECT_ORDER.indexOf(effect);
}

function assertNeverHostedContextEffect(_effect: never): never {
  throw new Error("Unhandled hosted context side-effect");
}

function assertHostedContextEffectPlanOrder(
  plan: readonly HostedContextSideEffectPlanEntry[],
): void {
  const seen = new Set<HostedContextMaterializationSideEffect>();
  for (let index = 1; index < plan.length; index += 1) {
    const previous = plan[index - 1]!;
    const current = plan[index]!;
    if (
      getHostedContextEffectOrderIndex(previous.effect) >
      getHostedContextEffectOrderIndex(current.effect)
    ) {
      throw new Error(
        `Hosted context side-effect plan is out of order: ${previous.effect} before ${current.effect}`,
      );
    }
  }

  for (const entry of plan) {
    if (seen.has(entry.effect)) {
      throw new Error(`Hosted context side-effect plan has duplicate effect: ${entry.effect}`);
    }
    seen.add(entry.effect);
  }
}

export interface HostedContextMaterializationInput {
  runtime: BrewvaHostedRuntimePort;
  telemetry: HostedContextTelemetry;
  delegationStore?: HostedDelegationStore;
  sessionId: string;
  turn: number;
  contextScopeId?: string;
  systemPrompt: string;
  rendered: HostedContextRenderResult;
  usage?: ContextBudgetUsage;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason: string | null;
  workbenchContextRendered: boolean;
  capabilityDisclosureRendered: boolean;
  surfacedDelegationRunIds: readonly string[];
}

export function planHostedContextEffects(
  input: Pick<
    HostedContextMaterializationInput,
    | "gateStatus"
    | "pendingCompactionReason"
    | "capabilityDisclosureRendered"
    | "workbenchContextRendered"
    | "surfacedDelegationRunIds"
  >,
): readonly HostedContextSideEffectPlanEntry[] {
  const effects: HostedContextSideEffectPlanEntry[] = [{ effect: "usage_observed" }];

  if (input.gateStatus.required) {
    effects.push({ effect: "hard_gate_telemetry_emitted" });
  }

  if (input.pendingCompactionReason && !input.gateStatus.required) {
    effects.push({ effect: "compaction_advisory_telemetry_emitted" });
  }

  if (input.gateStatus.required || input.pendingCompactionReason) {
    effects.push({ effect: "compaction_nudge_rendered" });
  }

  effects.push({ effect: "context_composed_emitted" }, { effect: "telemetry_emitted" });

  if (input.capabilityDisclosureRendered) {
    effects.push({ effect: "capability_disclosure_rendered" });
  }

  if (input.workbenchContextRendered) {
    effects.push({ effect: "workbench_context_rendered" });
  }

  effects.push({ effect: "prompt_stability_observed" });

  if (input.surfacedDelegationRunIds.length > 0) {
    effects.push({ effect: "delegation_outcome_surfaced" });
  }

  return effects;
}

export function commitHostedContextEffects(
  plan: readonly HostedContextSideEffectPlanEntry[],
  input: HostedContextMaterializationInput,
): HostedContextSideEffectLedger {
  assertHostedContextEffectPlanOrder(plan);
  const effects: HostedContextSideEffect[] = [];

  const observation = buildPromptStabilityObservation({
    systemPrompt: input.systemPrompt,
    composedContent: input.rendered.content,
    contextScopeId: input.contextScopeId,
    turn: input.turn,
  });

  for (const entry of plan) {
    switch (entry.effect) {
      case "usage_observed":
        input.runtime.operator.context.usage.observe(input.sessionId, input.usage);
        break;
      case "hard_gate_telemetry_emitted":
        input.telemetry.emitHardGateRequired({
          sessionId: input.sessionId,
          turn: input.turn,
          reason: "hard_limit",
          gateStatus: input.gateStatus,
        });
        break;
      case "compaction_advisory_telemetry_emitted":
        input.telemetry.emitCompactionAdvisory({
          sessionId: input.sessionId,
          turn: input.turn,
          reason: input.pendingCompactionReason ?? "compaction_advised",
          gateStatus: input.gateStatus,
        });
        break;
      case "compaction_nudge_rendered":
        break;
      case "context_composed_emitted":
        input.telemetry.emitContextComposed({
          sessionId: input.sessionId,
          turn: input.turn,
          rendered: input.rendered,
          workbenchContextRendered: input.workbenchContextRendered,
        });
        break;
      case "telemetry_emitted":
      case "capability_disclosure_rendered":
      case "workbench_context_rendered":
        break;
      case "prompt_stability_observed": {
        const observed = input.runtime.operator.context.prompt.observeStability(
          input.sessionId,
          observation,
        );
        const contextStatus = input.runtime.inspect.context.usage.getStatus(
          input.sessionId,
          input.usage,
        );
        recordPromptStabilityEvidence({
          workspaceRoot: input.runtime.identity.workspaceRoot,
          sessionId: input.sessionId,
          observed,
          compactionAdvised: contextStatus.compactionAdvised,
          forcedCompaction: contextStatus.forcedCompaction,
          usageRatio: contextStatus.usageRatio,
          pendingCompactionReason: input.pendingCompactionReason,
          gateRequired: input.gateStatus.required,
        });
        break;
      }
      case "delegation_outcome_surfaced":
        input.delegationStore?.markSurfaced({
          sessionId: input.sessionId,
          turn: input.turn,
          runIds: input.surfacedDelegationRunIds,
        });
        break;
      default:
        assertNeverHostedContextEffect(entry.effect);
    }
    effects.push(entry.effect);
  }

  return { effects };
}

export function commitHostedContextSideEffects(
  input: HostedContextMaterializationInput,
): HostedContextSideEffectLedger {
  return commitHostedContextEffects(planHostedContextEffects(input), input);
}

export function observeHostedProviderCache(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  observation: Parameters<
    BrewvaHostedRuntimePort["operator"]["context"]["providerCache"]["observe"]
  >[1];
}): HostedContextSideEffectLedger {
  const observed = input.runtime.operator.context.providerCache.observe(
    input.sessionId,
    input.observation,
  );
  recordProviderCacheObservationEvidence({
    workspaceRoot: input.runtime.identity.workspaceRoot,
    sessionId: input.sessionId,
    observed,
  });
  return { effects: ["provider_cache_observed"] };
}

export function rememberHostedVisibleReadState(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  state: Parameters<
    BrewvaHostedRuntimePort["operator"]["context"]["visibleRead"]["rememberState"]
  >[1];
}): HostedContextSideEffectLedger {
  input.runtime.operator.context.visibleRead.rememberState(input.sessionId, input.state);
  return { effects: ["visible_read_state_remembered"] };
}
