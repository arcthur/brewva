import {
  CONTEXT_SOURCES,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  type BrewvaRuntime,
  type ContextBudgetUsage,
  type ContextInjectionEntry,
} from "@brewva/brewva-runtime";
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
import { resolveRecoveryWorkingSetBlock } from "./recovery-working-set.js";
import { buildSkillFirstPolicyBlock, type SkillRecommendationSet } from "./skill-first.js";

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
    required: boolean;
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
  runtime: BrewvaRuntime,
  delegationStore: HostedDelegationStore | undefined,
): ContextComposerRuntime {
  return {
    events: runtime.events,
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
  runtime: BrewvaRuntime,
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
  return runtime.context.buildInjection(
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
      required: input.skillRecommendations.required,
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
  runtime: BrewvaRuntime,
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

  if (input.emitEvent !== false) {
    runtime.events.record({
      sessionId: input.sessionId,
      type: SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
      payload: {
        schema: "brewva.skill_recommendation.v1",
        required: input.recommendations.required,
        activeSkill: input.recommendations.activeSkillName,
        recommendations: input.recommendations.recommendations.map((entry) => ({
          name: entry.name,
          category: entry.category,
          score: entry.score,
          primary: entry.primary,
          reasons: entry.reasons,
        })),
      },
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

export function createHostedContextInjectionPipeline(
  extensionApi: ExtensionAPI,
  runtime: BrewvaRuntime,
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
      runtime.context.observeUsage(input.sessionId, input.usage);

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

      const initialSupplementalBlocks = appendSupplementalContextBlocks(runtime, {
        sessionId: input.sessionId,
        usage: input.usage,
        injectionScopeId,
        blocks: [
          ...[
            resolveRecoveryWorkingSetBlock(runtime, {
              sessionId: input.sessionId,
              delegationStore: options.delegationStore,
            }),
          ].filter((block): block is NonNullable<typeof block> => block !== null),
          ...resolveSupplementalContextBlocks({
            runtime: contextComposerRuntime,
            sessionId: input.sessionId,
            gateStatus,
            pendingCompactionReason,
            capabilityView,
          }),
          ...buildSkillRecommendationBlocks(runtime, {
            sessionId: input.sessionId,
            recommendations: skillRecommendations,
            emitEvent: gateStatus.required,
          }),
        ],
      });
      const systemPromptWithContract = applyContextContract(
        input.systemPrompt,
        runtime,
        input.sessionId,
        input.usage,
      );

      if (gateStatus.required) {
        statePort.setLastRuntimeGateRequired(input.sessionId, true);
        const composed = composeContextBlocks({
          runtime: contextComposerRuntime,
          sessionId: input.sessionId,
          gateStatus,
          pendingCompactionReason,
          capabilityView,
          admittedEntries: [],
          injectionAccepted: false,
          supplementalBlocks: initialSupplementalBlocks,
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

      const supplementalBlocks = appendSupplementalContextBlocks(runtime, {
        sessionId: input.sessionId,
        usage: input.usage,
        injectionScopeId,
        blocks: [
          ...[
            resolveRecoveryWorkingSetBlock(runtime, {
              sessionId: input.sessionId,
              delegationStore: options.delegationStore,
            }),
          ].filter((block): block is NonNullable<typeof block> => block !== null),
          ...resolveSupplementalContextBlocks({
            runtime: contextComposerRuntime,
            sessionId: input.sessionId,
            gateStatus,
            pendingCompactionReason,
            capabilityView,
          }),
          ...buildSkillRecommendationBlocks(runtime, {
            sessionId: input.sessionId,
            recommendations: skillRecommendations,
          }),
        ],
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
