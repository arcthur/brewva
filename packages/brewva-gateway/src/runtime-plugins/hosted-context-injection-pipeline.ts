import {
  CONTEXT_SOURCES,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
  type ContextBudgetUsage,
} from "@brewva/brewva-runtime";
import { type ContextInjectionEntry, recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { HostedDelegationStore } from "../subagents/delegation-store.js";
import { type BuildCapabilityViewResult } from "./capability-view.js";
import { prepareContextComposerSupport } from "./context-composer-support.js";
import {
  type ComposedContextBlock,
  type ContextComposerRuntime,
  type ContextComposerResult,
  composeContextBlocks,
  resolveSupplementalContextBlocks,
} from "./context-composer.js";
import { applyContextContract } from "./context-contract.js";
import { resolveInjectionScopeId } from "./context-shared.js";
import { appendSupplementalContextBlocks } from "./context-supplemental.js";
import type { HostedContextGateStatePort } from "./hosted-compaction-controller.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import { buildReadPathRecoveryBlocks } from "./read-path-recovery.js";
import { resolveRecoveryWorkingSetBlock } from "./recovery-working-set.js";
import {
  buildSkillRecommendationReceiptPayload,
  buildSkillFirstPolicyBlock,
  type SkillRecommendationGateMode,
  type SkillRecommendationSet,
} from "./skill-first.js";

export const HOSTED_CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";

export interface HostedInjectionSessionManager {
  getLeafId?: () => string | null | undefined;
}

export interface HostedContextInjectionInput {
  sessionId: string;
  sessionManager: HostedInjectionSessionManager;
  prompt: string;
  systemPrompt: unknown;
  usage?: ContextBudgetUsage;
}

export interface HostedContextInjectionMessageDetails {
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  gateRequired: boolean;
  contextComposition: {
    narrativeRatio: number;
    narrativeTokens: number;
    constraintTokens: number;
    diagnosticTokens: number;
  };
  capabilityView: {
    requested: string[];
    detailNames: string[];
    missing: string[];
  };
  skillRecommendation: {
    gateMode: SkillRecommendationGateMode;
    taskSpecReady: boolean;
    names: string[];
  };
}

export interface HostedContextInjectionResult {
  systemPrompt: string;
  message: {
    customType: typeof HOSTED_CONTEXT_INJECTION_MESSAGE_TYPE;
    content: string;
    display: false;
    details: HostedContextInjectionMessageDetails;
  };
}

export interface HostedContextInjectionPipeline {
  beforeAgentStart: (input: HostedContextInjectionInput) => Promise<HostedContextInjectionResult>;
}

export interface HostedContextInjectionPipelineOptions {
  delegationStore?: HostedDelegationStore;
  contextProfile?: "minimal" | "standard" | "full";
}

const CONTEXT_PROFILES = {
  minimal: [] as const,
  standard: [
    CONTEXT_SOURCES.runtimeStatus,
    CONTEXT_SOURCES.taskState,
    CONTEXT_SOURCES.toolOutputsDistilled,
    CONTEXT_SOURCES.projectionWorking,
  ] as const,
  full: null,
} as const;

function resolveContextSourceAllowlist(
  profile: HostedContextInjectionPipelineOptions["contextProfile"],
): ReadonlySet<string> | undefined {
  if (!profile || profile === "full") {
    return undefined;
  }
  return new Set(CONTEXT_PROFILES[profile]);
}

function createContextComposerRuntime(
  runtime: BrewvaHostedRuntimePort,
  delegationStore: HostedDelegationStore | undefined,
): ContextComposerRuntime {
  return {
    inspect: {
      events: runtime.inspect.events,
    },
    delegation: delegationStore
      ? {
          listRuns: (sessionId, query) => delegationStore.listRuns(sessionId, query),
          listPendingOutcomes: (sessionId, query) =>
            delegationStore.listPendingOutcomes(sessionId, query),
        }
      : undefined,
  };
}

function markSurfacedDelegationOutcomes(
  delegationStore: HostedDelegationStore | undefined,
  input: {
    sessionId: string;
    turn: number;
    runIds: readonly string[];
  },
): void {
  delegationStore?.markSurfaced(input);
}

async function resolveContextInjection(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    prompt: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    sourceAllowlist?: ReadonlySet<string>;
  },
): Promise<{
  text: string;
  entries: ContextInjectionEntry[];
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}> {
  return runtime.maintain.context.buildInjection(
    input.sessionId,
    input.prompt,
    input.usage,
    input.injectionScopeId,
    input.sourceAllowlist,
  );
}

function buildMessageDetails(input: {
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  gateRequired: boolean;
  composed: ContextComposerResult;
  capabilityView: BuildCapabilityViewResult;
  skillRecommendations: SkillRecommendationSet;
}): HostedContextInjectionMessageDetails {
  return {
    originalTokens: input.originalTokens,
    finalTokens: input.finalTokens,
    truncated: input.truncated,
    gateRequired: input.gateRequired,
    contextComposition: {
      narrativeRatio: input.composed.metrics.narrativeRatio,
      narrativeTokens: input.composed.metrics.narrativeTokens,
      constraintTokens: input.composed.metrics.constraintTokens,
      diagnosticTokens: input.composed.metrics.diagnosticTokens,
    },
    capabilityView: {
      requested: input.capabilityView.requested,
      detailNames: input.capabilityView.details.map((detail) => detail.name),
      missing: input.capabilityView.missing,
    },
    skillRecommendation: {
      gateMode: input.skillRecommendations.gateMode,
      taskSpecReady: input.skillRecommendations.taskSpecReady,
      names: input.skillRecommendations.recommendations.map((entry) => entry.name),
    },
  };
}

function buildHiddenInjectionResult(input: {
  systemPrompt: string;
  composed: ContextComposerResult;
  details: HostedContextInjectionMessageDetails;
}): HostedContextInjectionResult {
  return {
    systemPrompt: input.systemPrompt,
    message: {
      customType: HOSTED_CONTEXT_INJECTION_MESSAGE_TYPE,
      content: input.composed.content,
      display: false,
      details: input.details,
    },
  };
}

function buildSkillRecommendationBlocks(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    recommendations: SkillRecommendationSet;
    emitEvent?: boolean;
  },
): ComposedContextBlock[] {
  const content = buildSkillFirstPolicyBlock(input.recommendations);
  if (!content) {
    return [];
  }

  const payload = buildSkillRecommendationReceiptPayload(input.recommendations);
  if (input.emitEvent !== false) {
    if (!payload) {
      return [];
    }
    recordRuntimeEvent(runtime, {
      sessionId: input.sessionId,
      type: SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
      payload,
    });
  }

  return [
    {
      id: "skill-first-policy",
      category: "constraint",
      content,
      estimatedTokens: 0,
    },
  ];
}

function buildSkillRoutingAvailabilityBlocks(
  runtime: BrewvaHostedRuntimePort,
): ComposedContextBlock[] {
  const loadReport = runtime.inspect.skills.getLoadReport();
  if (loadReport.loadedSkills.length <= 0 || loadReport.routableSkills.length > 0) {
    return [];
  }

  const lines = ["[Brewva Skill Routing Availability]"];
  if (!loadReport.routingEnabled) {
    lines.push("Skills are loaded, but automatic skill routing is disabled in this session.");
  } else {
    lines.push("Skills are loaded, but none are routable under the current routing scopes.");
  }
  lines.push("Use `skill_load` before specialized work instead of continuing without a skill.");
  lines.push(`routing_scopes: ${loadReport.routingScopes.join(", ") || "none"}`);
  if (loadReport.hiddenSkills.length > 0) {
    lines.push(`hidden_skills: ${loadReport.hiddenSkills.slice(0, 6).join(", ")}`);
  }

  return [
    {
      id: "skill-routing-availability",
      category: "diagnostic",
      content: lines.join("\n"),
      estimatedTokens: 0,
    },
  ];
}

function buildHostedSupplementalBlocks(
  runtime: BrewvaHostedRuntimePort,
  contextComposerRuntime: ContextComposerRuntime,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    delegationStore?: HostedDelegationStore;
    gateStatus: ReturnType<typeof prepareContextComposerSupport>["gateStatus"];
    pendingCompactionReason: ReturnType<
      typeof prepareContextComposerSupport
    >["pendingCompactionReason"];
    capabilityView: BuildCapabilityViewResult;
    skillRecommendations: SkillRecommendationSet;
    emitSkillRecommendationEvent?: boolean;
  },
): ComposedContextBlock[] {
  return appendSupplementalContextBlocks(runtime, {
    sessionId: input.sessionId,
    usage: input.usage,
    injectionScopeId: input.injectionScopeId,
    blocks: [
      ...[
        resolveRecoveryWorkingSetBlock(runtime, {
          sessionId: input.sessionId,
          delegationStore: input.delegationStore,
        }),
      ].filter((block): block is NonNullable<typeof block> => block !== null),
      ...buildSkillRoutingAvailabilityBlocks(runtime),
      ...resolveSupplementalContextBlocks({
        runtime: contextComposerRuntime,
        sessionId: input.sessionId,
        gateStatus: input.gateStatus,
        pendingCompactionReason: input.pendingCompactionReason,
        capabilityView: input.capabilityView,
      }),
      ...buildReadPathRecoveryBlocks(runtime, input.sessionId),
      ...buildSkillRecommendationBlocks(runtime, {
        sessionId: input.sessionId,
        recommendations: input.skillRecommendations,
        emitEvent: input.emitSkillRecommendationEvent,
      }),
    ],
  });
}

export function createHostedContextInjectionPipeline(
  extensionApi: ExtensionAPI,
  runtime: BrewvaHostedRuntimePort,
  telemetry: HostedContextTelemetry,
  statePort: HostedContextGateStatePort,
  options: HostedContextInjectionPipelineOptions = {},
): HostedContextInjectionPipeline {
  const contextComposerRuntime = createContextComposerRuntime(runtime, options.delegationStore);
  const sourceAllowlist = resolveContextSourceAllowlist(options.contextProfile);

  return {
    async beforeAgentStart(input) {
      const turn = statePort.getTurnIndex(input.sessionId);
      const injectionScopeId = resolveInjectionScopeId(input.sessionManager);
      runtime.maintain.context.observeUsage(input.sessionId, input.usage);

      let { gateStatus, pendingCompactionReason, capabilityView, skillRecommendations } =
        prepareContextComposerSupport({
          runtime,
          extensionApi,
          sessionId: input.sessionId,
          prompt: input.prompt,
          usage: input.usage,
        });

      if (gateStatus.required) {
        telemetry.emitHardGateRequired({
          sessionId: input.sessionId,
          turn,
          reason: "hard_limit",
          gateStatus,
        });
      }
      const systemPromptWithContract = applyContextContract(
        input.systemPrompt,
        runtime,
        input.sessionId,
        input.usage,
      );

      if (gateStatus.required) {
        const supplementalBlocks = buildHostedSupplementalBlocks(runtime, contextComposerRuntime, {
          sessionId: input.sessionId,
          usage: input.usage,
          injectionScopeId,
          delegationStore: options.delegationStore,
          gateStatus,
          pendingCompactionReason,
          capabilityView,
          skillRecommendations,
          emitSkillRecommendationEvent: gateStatus.required,
        });
        statePort.setLastRuntimeGateRequired(input.sessionId, true);
        const composed = composeContextBlocks({
          runtime: contextComposerRuntime,
          sessionId: input.sessionId,
          gateStatus,
          pendingCompactionReason,
          capabilityView,
          admittedEntries: [],
          injectionAccepted: false,
          supplementalBlocks,
          includeDefaultSupplementalBlocks: false,
        });
        telemetry.emitContextComposed({
          sessionId: input.sessionId,
          turn,
          composed,
          injectionAccepted: false,
        });
        markSurfacedDelegationOutcomes(options.delegationStore, {
          sessionId: input.sessionId,
          turn,
          runIds: composed.surfacedDelegationRunIds,
        });
        return buildHiddenInjectionResult({
          systemPrompt: systemPromptWithContract,
          composed,
          details: buildMessageDetails({
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
            gateRequired: true,
            composed,
            capabilityView,
            skillRecommendations,
          }),
        });
      }

      const injection = await resolveContextInjection(runtime, {
        sessionId: input.sessionId,
        prompt: input.prompt,
        usage: input.usage,
        injectionScopeId,
        sourceAllowlist,
      });

      const supportAfterInjection = prepareContextComposerSupport({
        runtime,
        extensionApi,
        sessionId: input.sessionId,
        prompt: input.prompt,
        usage: input.usage,
      });
      const gateStatusAfterInjection = supportAfterInjection.gateStatus;
      if (!gateStatus.required && gateStatusAfterInjection.required) {
        telemetry.emitHardGateRequired({
          sessionId: input.sessionId,
          turn,
          reason: "hard_limit",
          gateStatus: gateStatusAfterInjection,
        });
      }

      gateStatus = gateStatusAfterInjection;
      pendingCompactionReason = supportAfterInjection.pendingCompactionReason;
      capabilityView = supportAfterInjection.capabilityView;
      skillRecommendations = supportAfterInjection.skillRecommendations;
      statePort.setLastRuntimeGateRequired(input.sessionId, gateStatus.required);

      const supplementalBlocks = buildHostedSupplementalBlocks(runtime, contextComposerRuntime, {
        sessionId: input.sessionId,
        usage: input.usage,
        injectionScopeId,
        delegationStore: options.delegationStore,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        skillRecommendations,
        emitSkillRecommendationEvent: true,
      });

      if (pendingCompactionReason && !gateStatus.required) {
        telemetry.emitCompactionAdvisory({
          sessionId: input.sessionId,
          turn,
          reason: pendingCompactionReason,
          gateStatus,
        });
      }

      const composed = composeContextBlocks({
        runtime: contextComposerRuntime,
        sessionId: input.sessionId,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        admittedEntries: injection.entries,
        injectionAccepted: injection.accepted,
        supplementalBlocks,
        includeDefaultSupplementalBlocks: false,
      });
      telemetry.emitContextComposed({
        sessionId: input.sessionId,
        turn,
        composed,
        injectionAccepted: injection.accepted,
      });
      markSurfacedDelegationOutcomes(options.delegationStore, {
        sessionId: input.sessionId,
        turn,
        runIds: composed.surfacedDelegationRunIds,
      });

      return buildHiddenInjectionResult({
        systemPrompt: systemPromptWithContract,
        composed,
        details: buildMessageDetails({
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
          gateRequired: gateStatus.required,
          composed,
          capabilityView,
          skillRecommendations,
        }),
      });
    },
  };
}
