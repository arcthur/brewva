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

export interface HostedModelContext {
  readonly sessionId: string;
  readonly turn: number;
  readonly contextScopeId?: string;
  readonly systemPrompt: string;
  readonly rendered: HostedContextRenderResult;
}

export interface HostedContextMaterializationAudit {
  readonly sessionId: string;
  readonly turn: number;
  readonly effectCount: number;
  readonly renderedBlockIds: readonly string[];
}

type PromptStabilityObservation = ReturnType<typeof buildPromptStabilityObservation>;
type ProviderCacheObservation = Parameters<
  BrewvaHostedRuntimePort["operator"]["context"]["providerCache"]["observe"]
>[1];
type VisibleReadState = Parameters<
  BrewvaHostedRuntimePort["operator"]["context"]["visibleRead"]["rememberState"]
>[1];

export type HostedContextEffectCommand =
  | {
      readonly effect: "usage_observed";
      readonly command: "observe_usage";
      readonly payload: {
        readonly sessionId: string;
        readonly usage?: ContextBudgetUsage;
      };
    }
  | {
      readonly effect: "hard_gate_telemetry_emitted";
      readonly command: "emit_hard_gate_required";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
        readonly reason: "hard_limit";
        readonly gateStatus: ContextCompactionGateStatus;
      };
    }
  | {
      readonly effect: "compaction_advisory_telemetry_emitted";
      readonly command: "emit_compaction_advisory";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
        readonly reason: string;
        readonly gateStatus: ContextCompactionGateStatus;
      };
    }
  | {
      readonly effect: "compaction_nudge_rendered";
      readonly command: "mark_compaction_nudge_rendered";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
        readonly reason: string;
      };
    }
  | {
      readonly effect: "context_composed_emitted";
      readonly command: "emit_context_composed";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
        readonly rendered: HostedContextRenderResult;
        readonly workbenchContextRendered: boolean;
      };
    }
  | {
      readonly effect: "telemetry_emitted";
      readonly command: "mark_telemetry_emitted";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
      };
    }
  | {
      readonly effect: "capability_disclosure_rendered";
      readonly command: "mark_capability_disclosure_rendered";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
      };
    }
  | {
      readonly effect: "consequence_digest_rendered";
      readonly command: "mark_consequence_digest_rendered";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
      };
    }
  | {
      readonly effect: "workbench_context_rendered";
      readonly command: "mark_workbench_context_rendered";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
      };
    }
  | {
      readonly effect: "prompt_stability_observed";
      readonly command: "observe_prompt_stability_and_record_evidence";
      readonly payload: {
        readonly sessionId: string;
        readonly observation: PromptStabilityObservation;
        readonly usage?: ContextBudgetUsage;
        readonly pendingCompactionReason: string | null;
        readonly gateRequired: boolean;
      };
    }
  | {
      readonly effect: "provider_cache_observed";
      readonly command: "observe_provider_cache_and_record_evidence";
      readonly payload: {
        readonly sessionId: string;
        readonly observation: ProviderCacheObservation;
      };
    }
  | {
      readonly effect: "visible_read_state_remembered";
      readonly command: "remember_visible_read_state";
      readonly payload: {
        readonly sessionId: string;
        readonly state: VisibleReadState;
      };
    }
  | {
      readonly effect: "delegation_outcome_surfaced";
      readonly command: "surface_delegation_outcome";
      readonly payload: {
        readonly sessionId: string;
        readonly turn: number;
        readonly runIds: readonly string[];
      };
    };

export type HostedContextMaterializationEffect = HostedContextEffectCommand["effect"];

export interface HostedContextMaterializationCommitResult {
  effects: HostedContextMaterializationEffect[];
}

export interface HostedContextMaterializationPlan {
  readonly modelContext: HostedModelContext;
  readonly effects: readonly HostedContextEffectCommand[];
  readonly audit: HostedContextMaterializationAudit;
}

type HostedContextCommandForEffect<TEffect extends HostedContextMaterializationEffect> = Extract<
  HostedContextEffectCommand,
  { readonly effect: TEffect }
>["command"];

type HostedContextEffectCommandEntry = {
  readonly [TEffect in HostedContextMaterializationEffect]: readonly [
    TEffect,
    HostedContextCommandForEffect<TEffect>,
  ];
}[HostedContextMaterializationEffect];

const HOSTED_CONTEXT_EFFECT_COMMAND_ENTRIES = [
  ["usage_observed", "observe_usage"],
  ["hard_gate_telemetry_emitted", "emit_hard_gate_required"],
  ["compaction_advisory_telemetry_emitted", "emit_compaction_advisory"],
  ["compaction_nudge_rendered", "mark_compaction_nudge_rendered"],
  ["context_composed_emitted", "emit_context_composed"],
  ["telemetry_emitted", "mark_telemetry_emitted"],
  ["capability_disclosure_rendered", "mark_capability_disclosure_rendered"],
  ["consequence_digest_rendered", "mark_consequence_digest_rendered"],
  ["workbench_context_rendered", "mark_workbench_context_rendered"],
  ["prompt_stability_observed", "observe_prompt_stability_and_record_evidence"],
  ["provider_cache_observed", "observe_provider_cache_and_record_evidence"],
  ["visible_read_state_remembered", "remember_visible_read_state"],
  ["delegation_outcome_surfaced", "surface_delegation_outcome"],
] as const satisfies readonly HostedContextEffectCommandEntry[];

type AssertNever<TValue extends never> = TValue;
type HostedContextEffectCommandEntryEffect =
  (typeof HOSTED_CONTEXT_EFFECT_COMMAND_ENTRIES)[number][0];
type _AllHostedContextEffectsHaveCommandEntries = AssertNever<
  Exclude<HostedContextMaterializationEffect, HostedContextEffectCommandEntryEffect>
>;
type _AllHostedContextCommandEntriesAreKnownEffects = AssertNever<
  Exclude<HostedContextEffectCommandEntryEffect, HostedContextMaterializationEffect>
>;

function buildHostedContextEffectCommandMap(): ReadonlyMap<
  HostedContextMaterializationEffect,
  HostedContextEffectCommand["command"]
> {
  const commandsByEffect = HOSTED_CONTEXT_EFFECT_COMMAND_ENTRIES.reduce<
    Map<HostedContextMaterializationEffect, HostedContextEffectCommand["command"]>
  >((commands, [effect, command]) => commands.set(effect, command), new Map());
  if (commandsByEffect.size !== HOSTED_CONTEXT_EFFECT_COMMAND_ENTRIES.length) {
    throw new Error("duplicate_hosted_context_effect_command_metadata");
  }
  return commandsByEffect;
}

export const HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER = Object.freeze(
  HOSTED_CONTEXT_EFFECT_COMMAND_ENTRIES.map(([effect]) => effect),
) satisfies readonly HostedContextMaterializationEffect[];

const HOSTED_CONTEXT_EFFECTS = new Set<string>(HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER);
const HOSTED_CONTEXT_EFFECT_COMMANDS = buildHostedContextEffectCommandMap();

function getHostedContextEffectOrderIndex(effect: HostedContextMaterializationEffect): number {
  return HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER.indexOf(effect);
}

function assertNeverHostedContextMaterializationEffect(_effect: never): never {
  throw new Error("Unhandled hosted context materialization effect");
}

function assertHostedContextMaterializationPlan(plan: HostedContextMaterializationPlan): void {
  const seen = new Set<HostedContextMaterializationEffect>();

  for (let index = 0; index < plan.effects.length; index += 1) {
    const current = plan.effects[index] as HostedContextEffectCommand | undefined;
    if (!current || !HOSTED_CONTEXT_EFFECTS.has(current.effect)) {
      const effect = current && "effect" in current ? current.effect : "missing";
      throw new Error(`Hosted context materialization plan has unsupported effect: ${effect}`);
    }
    const expectedCommand = HOSTED_CONTEXT_EFFECT_COMMANDS.get(current.effect);
    if (current.command !== expectedCommand) {
      throw new Error(
        `Hosted context materialization plan has unsupported command: ${current.effect}/${current.command}`,
      );
    }

    if (seen.has(current.effect)) {
      throw new Error(
        `Hosted context materialization plan has duplicate effect: ${current.effect}`,
      );
    }
    seen.add(current.effect);

    const previous = plan.effects[index - 1];
    if (
      previous &&
      getHostedContextEffectOrderIndex(previous.effect) >
        getHostedContextEffectOrderIndex(current.effect)
    ) {
      throw new Error(
        `Hosted context materialization plan is out of order: ${previous.effect} before ${current.effect}`,
      );
    }
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
  consequenceDigestRendered: boolean;
  surfacedDelegationRunIds: readonly string[];
}

export function planHostedContextMaterialization(
  input: Omit<HostedContextMaterializationInput, "runtime" | "telemetry" | "delegationStore">,
): HostedContextMaterializationPlan {
  const effects: HostedContextEffectCommand[] = [
    {
      effect: "usage_observed",
      command: "observe_usage",
      payload: {
        sessionId: input.sessionId,
        usage: input.usage,
      },
    },
  ];

  if (input.gateStatus.required) {
    effects.push({
      effect: "hard_gate_telemetry_emitted",
      command: "emit_hard_gate_required",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
        reason: "hard_limit",
        gateStatus: input.gateStatus,
      },
    });
  }

  if (input.pendingCompactionReason && !input.gateStatus.required) {
    effects.push({
      effect: "compaction_advisory_telemetry_emitted",
      command: "emit_compaction_advisory",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
        reason: input.pendingCompactionReason,
        gateStatus: input.gateStatus,
      },
    });
  }

  if (input.gateStatus.required || input.pendingCompactionReason) {
    effects.push({
      effect: "compaction_nudge_rendered",
      command: "mark_compaction_nudge_rendered",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
        reason: input.pendingCompactionReason ?? "hard_limit",
      },
    });
  }

  effects.push(
    {
      effect: "context_composed_emitted",
      command: "emit_context_composed",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
        rendered: input.rendered,
        workbenchContextRendered: input.workbenchContextRendered,
      },
    },
    {
      effect: "telemetry_emitted",
      command: "mark_telemetry_emitted",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
      },
    },
  );

  if (input.capabilityDisclosureRendered) {
    effects.push({
      effect: "capability_disclosure_rendered",
      command: "mark_capability_disclosure_rendered",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
      },
    });
  }

  if (input.consequenceDigestRendered) {
    effects.push({
      effect: "consequence_digest_rendered",
      command: "mark_consequence_digest_rendered",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
      },
    });
  }

  if (input.workbenchContextRendered) {
    effects.push({
      effect: "workbench_context_rendered",
      command: "mark_workbench_context_rendered",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
      },
    });
  }

  effects.push({
    effect: "prompt_stability_observed",
    command: "observe_prompt_stability_and_record_evidence",
    payload: {
      sessionId: input.sessionId,
      observation: buildPromptStabilityObservation({
        systemPrompt: input.systemPrompt,
        composedContent: input.rendered.content,
        contextScopeId: input.contextScopeId,
        turn: input.turn,
      }),
      usage: input.usage,
      pendingCompactionReason: input.pendingCompactionReason,
      gateRequired: input.gateStatus.required,
    },
  });

  if (input.surfacedDelegationRunIds.length > 0) {
    effects.push({
      effect: "delegation_outcome_surfaced",
      command: "surface_delegation_outcome",
      payload: {
        sessionId: input.sessionId,
        turn: input.turn,
        runIds: input.surfacedDelegationRunIds,
      },
    });
  }

  return {
    modelContext: {
      sessionId: input.sessionId,
      turn: input.turn,
      contextScopeId: input.contextScopeId,
      systemPrompt: input.systemPrompt,
      rendered: input.rendered,
    },
    effects,
    audit: {
      sessionId: input.sessionId,
      turn: input.turn,
      effectCount: effects.length,
      renderedBlockIds: input.rendered.blocks.map((block) => block.id),
    },
  };
}

function requireTelemetry(
  telemetry: HostedContextTelemetry | undefined,
  command: HostedContextEffectCommand["command"],
): HostedContextTelemetry {
  if (!telemetry) {
    throw new Error(`hosted_context_telemetry_required:${command}`);
  }
  return telemetry;
}

export function commitHostedContextMaterialization(
  plan: HostedContextMaterializationPlan,
  input: {
    runtime: BrewvaHostedRuntimePort;
    telemetry?: HostedContextTelemetry;
    delegationStore?: HostedDelegationStore;
  },
): HostedContextMaterializationCommitResult {
  assertHostedContextMaterializationPlan(plan);
  const effects: HostedContextMaterializationEffect[] = [];

  for (const entry of plan.effects) {
    switch (entry.effect) {
      case "usage_observed":
        input.runtime.operator.context.usage.observe(entry.payload.sessionId, entry.payload.usage);
        break;
      case "hard_gate_telemetry_emitted":
        requireTelemetry(input.telemetry, entry.command).emitHardGateRequired(entry.payload);
        break;
      case "compaction_advisory_telemetry_emitted":
        requireTelemetry(input.telemetry, entry.command).emitCompactionAdvisory(entry.payload);
        break;
      case "compaction_nudge_rendered":
        break;
      case "context_composed_emitted":
        requireTelemetry(input.telemetry, entry.command).emitContextComposed(entry.payload);
        break;
      case "telemetry_emitted":
      case "capability_disclosure_rendered":
      case "consequence_digest_rendered":
      case "workbench_context_rendered":
        break;
      case "prompt_stability_observed": {
        const observed = input.runtime.operator.context.prompt.observeStability(
          entry.payload.sessionId,
          entry.payload.observation,
        );
        const contextStatus = input.runtime.inspect.context.usage.getStatus(
          entry.payload.sessionId,
          entry.payload.usage,
        );
        recordPromptStabilityEvidence({
          workspaceRoot: input.runtime.identity.workspaceRoot,
          sessionId: entry.payload.sessionId,
          observed,
          compactionAdvised: contextStatus.compactionAdvised,
          forcedCompaction: contextStatus.forcedCompaction,
          usageRatio: contextStatus.usageRatio,
          pendingCompactionReason: entry.payload.pendingCompactionReason,
          gateRequired: entry.payload.gateRequired,
        });
        break;
      }
      case "provider_cache_observed": {
        const observed = input.runtime.operator.context.providerCache.observe(
          entry.payload.sessionId,
          entry.payload.observation,
        );
        recordProviderCacheObservationEvidence({
          workspaceRoot: input.runtime.identity.workspaceRoot,
          sessionId: entry.payload.sessionId,
          observed,
        });
        break;
      }
      case "visible_read_state_remembered":
        input.runtime.operator.context.visibleRead.rememberState(
          entry.payload.sessionId,
          entry.payload.state,
        );
        break;
      case "delegation_outcome_surfaced":
        input.delegationStore?.markSurfaced(entry.payload);
        break;
      default:
        assertNeverHostedContextMaterializationEffect(entry);
    }
    effects.push(entry.effect);
  }

  return { effects };
}

export function planHostedProviderCacheObservation(input: {
  sessionId: string;
  observation: ProviderCacheObservation;
}): HostedContextMaterializationPlan {
  const effects: HostedContextEffectCommand[] = [
    {
      effect: "provider_cache_observed",
      command: "observe_provider_cache_and_record_evidence",
      payload: input,
    },
  ];
  return {
    modelContext: {
      sessionId: input.sessionId,
      turn: 0,
      systemPrompt: "",
      rendered: { content: "", blocks: [], totalTokens: 0, surfacedDelegationRunIds: [] },
    },
    effects,
    audit: {
      sessionId: input.sessionId,
      turn: 0,
      effectCount: effects.length,
      renderedBlockIds: [],
    },
  };
}

export function observeHostedProviderCache(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  observation: ProviderCacheObservation;
}): HostedContextMaterializationCommitResult {
  return commitHostedContextMaterialization(planHostedProviderCacheObservation(input), {
    runtime: input.runtime,
  });
}

export function planHostedVisibleReadStateMemory(input: {
  sessionId: string;
  state: VisibleReadState;
}): HostedContextMaterializationPlan {
  const effects: HostedContextEffectCommand[] = [
    {
      effect: "visible_read_state_remembered",
      command: "remember_visible_read_state",
      payload: input,
    },
  ];
  return {
    modelContext: {
      sessionId: input.sessionId,
      turn: 0,
      systemPrompt: "",
      rendered: { content: "", blocks: [], totalTokens: 0, surfacedDelegationRunIds: [] },
    },
    effects,
    audit: {
      sessionId: input.sessionId,
      turn: 0,
      effectCount: effects.length,
      renderedBlockIds: [],
    },
  };
}

export function rememberHostedVisibleReadState(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  state: VisibleReadState;
}): HostedContextMaterializationCommitResult {
  return commitHostedContextMaterialization(planHostedVisibleReadStateMemory(input), {
    runtime: input.runtime,
  });
}
