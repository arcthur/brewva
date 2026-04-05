import {
  BrewvaRuntime,
  createHostedRuntimePort,
  createToolRuntimePort,
  createTrustedLocalGovernancePort,
  getExactToolGovernanceDescriptor,
  sameToolGovernanceDescriptor,
  type BrewvaRuntimeOptions,
} from "@brewva/brewva-runtime";
import { createToolRuntimeInternalPort, recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildBrewvaTools,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
  type BrewvaSemanticReranker,
  type BrewvaToolOrchestration,
} from "@brewva/brewva-tools";
import type {
  ExtensionFactory as UpstreamExtensionFactory,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_HOSTED_ROUTING_SCOPES } from "../host/routing-defaults.js";
import type { HostedDelegationStore } from "../subagents/delegation-store.js";
import {
  createHostedToolExecutionCoordinator,
  wrapToolDefinitionsWithHostedExecutionTraits,
  type HostedToolExecutionCoordinator,
} from "../tool-execution-traits.js";
import { createCompletionGuardLifecycle, registerCompletionGuard } from "./completion-guard.js";
import { createContextTransformLifecycle } from "./context-transform.js";
import { createDeliberationMaintenanceLifecycle } from "./deliberation-maintenance.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { createNarrativeMemoryLifecycle } from "./narrative-memory-lifecycle.js";
import { registerProviderRequestRecovery } from "./provider-request-recovery.js";
import { createQualityGateLifecycle, registerQualityGate } from "./quality-gate.js";
import { createReadPathRecoveryLifecycle } from "./read-path-recovery.js";
import { createRuntimeTurnClockStore } from "./runtime-turn-clock.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import {
  createToolSurfaceLifecycle,
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "./tool-surface.js";
import { registerTurnLifecyclePorts, type TurnLifecyclePort } from "./turn-lifecycle-port.js";

export type RuntimePlugin = UpstreamExtensionFactory;
export type RuntimePluginApi = Parameters<RuntimePlugin>[0];

export interface CreateHostedTurnPipelineOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
  orchestration?: BrewvaToolOrchestration;
  delegationStore?: HostedDelegationStore;
  managedToolNames?: readonly string[];
  contextProfile?: "minimal" | "standard" | "full";
  semanticReranker?: BrewvaSemanticReranker;
  ports?: readonly TurnLifecyclePort[];
  toolExecutionCoordinator?: HostedToolExecutionCoordinator;
  hostedToolDefinitionsByName?: ReadonlyMap<string, ToolDefinition>;
}

function assertHostedPipelineRuntimeCompatibility(options: CreateHostedTurnPipelineOptions): void {
  if (options.runtime && options.routingScopes && options.routingScopes.length > 0) {
    throw new Error(
      "routingScopes must be applied when constructing BrewvaRuntime; createHostedTurnPipeline does not mutate runtime.config",
    );
  }
  if (options.runtime && options.routingDefaultScopes && options.routingDefaultScopes.length > 0) {
    throw new Error(
      "routingDefaultScopes must be applied when constructing BrewvaRuntime; createHostedTurnPipeline does not infer runtime config intent from an existing runtime",
    );
  }
}

function buildManagedTools(
  runtime: BrewvaRuntime,
  options: Pick<
    CreateHostedTurnPipelineOptions,
    "managedToolNames" | "orchestration" | "delegationStore" | "semanticReranker"
  >,
): ReturnType<typeof buildBrewvaTools> {
  const delegationStore = options.delegationStore;
  const delegation = delegationStore
    ? {
        listRuns: (sessionId: string, query?: Parameters<HostedDelegationStore["listRuns"]>[1]) =>
          delegationStore.listRuns(sessionId, query),
        listPendingOutcomes: (
          sessionId: string,
          query?: Parameters<HostedDelegationStore["listPendingOutcomes"]>[1],
        ) => delegationStore.listPendingOutcomes(sessionId, query),
      }
    : undefined;
  return buildBrewvaTools({
    runtime: {
      ...createToolRuntimePort(runtime),
      internal: createToolRuntimeInternalPort(runtime),
      ...(options.semanticReranker ? { semanticReranker: options.semanticReranker } : {}),
    },
    orchestration: options.orchestration,
    delegation,
    toolNames: options.managedToolNames,
  });
}

function registerGovernanceDescriptors(
  runtime: BrewvaRuntime,
  tools: ReturnType<typeof buildBrewvaTools>,
): void {
  for (const tool of tools) {
    const metadata = getBrewvaToolMetadata(tool);
    if (!metadata?.governance) {
      continue;
    }
    const exactGovernance = getExactToolGovernanceDescriptor(tool.name);
    if (sameToolGovernanceDescriptor(exactGovernance, metadata.governance)) {
      continue;
    }
    runtime.maintain.tools.registerGovernanceDescriptor(tool.name, metadata.governance);
  }
}

function registerHostedPipeline(
  runtime: BrewvaRuntime,
  runtimePluginApi: RuntimePluginApi,
  tools: ReturnType<typeof buildBrewvaTools>,
  extraToolDefinitionsByName: ReadonlyMap<string, ToolDefinition>,
  registerTools: boolean,
  delegationStore: HostedDelegationStore | undefined,
  contextProfile: "minimal" | "standard" | "full" | undefined,
  semanticReranker: BrewvaSemanticReranker | undefined,
  userPorts: readonly TurnLifecyclePort[],
): void {
  const toolDefinitionsByName = new Map<string, ToolDefinition>(extraToolDefinitionsByName);
  for (const tool of tools) {
    toolDefinitionsByName.set(tool.name, tool);
  }
  const turnClock = createRuntimeTurnClockStore();
  const hostedRuntime = createHostedRuntimePort(runtime);
  const toolSurfaceRuntime: ToolSurfaceRuntime = {
    config: hostedRuntime.config,
    inspect: hostedRuntime.inspect,
    recordEvent: (input: { sessionId: string; type: string; payload?: object }) =>
      recordRuntimeEvent(hostedRuntime, input),
  };
  const contextTransform = createContextTransformLifecycle(runtimePluginApi, hostedRuntime, {
    delegationStore,
    turnClock,
    contextProfile,
  });
  const deliberationMaintenance = createDeliberationMaintenanceLifecycle(runtime);
  const narrativeMemory = createNarrativeMemoryLifecycle(runtime, semanticReranker);
  const qualityGate = createQualityGateLifecycle(hostedRuntime, {
    toolDefinitionsByName,
  });
  const toolSurface = createToolSurfaceLifecycle(runtimePluginApi, toolSurfaceRuntime, {
    dynamicToolDefinitions: registerTools ? toolDefinitionsByName : undefined,
  });
  const completionGuard = createCompletionGuardLifecycle(runtimePluginApi, hostedRuntime);
  const readPathRecovery = createReadPathRecoveryLifecycle(hostedRuntime);

  runtimePluginApi.on("tool_call", qualityGate.toolCall);
  runtimePluginApi.on("context", contextTransform.context);
  registerProviderRequestRecovery(runtimePluginApi, runtime);
  registerEventStream(runtimePluginApi, hostedRuntime, turnClock, {
    toolDefinitionsByName,
  });
  registerLedgerWriter(runtimePluginApi, hostedRuntime);
  registerToolResultDistiller(runtimePluginApi, hostedRuntime);
  registerTurnLifecyclePorts(runtimePluginApi, [
    {
      beforeAgentStart: deliberationMaintenance.beforeAgentStart,
      agentEnd: deliberationMaintenance.agentEnd,
    },
    {
      turnStart: contextTransform.turnStart,
      beforeAgentStart: toolSurface.beforeAgentStart,
      sessionCompact: contextTransform.sessionCompact,
      sessionShutdown: contextTransform.sessionShutdown,
    },
    {
      input: qualityGate.input,
      beforeAgentStart: contextTransform.beforeAgentStart,
      toolResult: qualityGate.toolResult,
    },
    {
      toolResult: readPathRecovery.toolResult,
    },
    {
      toolResult: toolSurface.toolResult,
      sessionShutdown: toolSurface.sessionShutdown,
    },
    narrativeMemory,
    {
      agentEnd: completionGuard.agentEnd,
      sessionShutdown: completionGuard.sessionShutdown,
    },
    ...userPorts,
  ]);
}

export function createHostedTurnPipeline(
  options: CreateHostedTurnPipelineOptions = {},
): RuntimePlugin {
  return (runtimePluginApi) => {
    assertHostedPipelineRuntimeCompatibility(options);
    const runtime =
      options.runtime ??
      new BrewvaRuntime({
        ...options,
        routingDefaultScopes:
          options.routingScopes && options.routingScopes.length > 0
            ? options.routingDefaultScopes
            : (options.routingDefaultScopes ?? [...DEFAULT_HOSTED_ROUTING_SCOPES]),
        governancePort:
          options.governancePort ?? createTrustedLocalGovernancePort({ profile: "team" }),
      });
    const executionCoordinator =
      options.toolExecutionCoordinator ?? createHostedToolExecutionCoordinator();
    const allTools =
      wrapToolDefinitionsWithHostedExecutionTraits(
        buildManagedTools(runtime, options),
        executionCoordinator,
      ) ?? [];
    const registerTools = options.registerTools !== false;

    registerGovernanceDescriptors(runtime, allTools);
    if (registerTools) {
      for (const tool of allTools) {
        if (getBrewvaToolSurface(tool.name) !== "base") {
          continue;
        }
        runtimePluginApi.registerTool(tool);
      }
    }

    registerHostedPipeline(
      runtime,
      runtimePluginApi,
      allTools,
      options.hostedToolDefinitionsByName ?? new Map<string, ToolDefinition>(),
      registerTools,
      options.delegationStore,
      options.contextProfile,
      options.semanticReranker,
      options.ports ?? [],
    );
  };
}

export { registerContextTransform } from "./context-transform.js";
export { createRuntimeTurnClockStore, type RuntimeTurnClockStore } from "./runtime-turn-clock.js";
export {
  composeContextBlocks,
  type ComposedContextBlock,
  type ContextBlockCategory,
  type ContextComposerInput,
  type ContextComposerMetrics,
  type ContextComposerResult,
} from "./context-composer.js";
export {
  buildCapabilityView,
  renderCapabilityView,
  type CapabilityAccessDecision,
  type CapabilityDetail,
  type CapabilityHintId,
  type CapabilityPolicyId,
  type CapabilityView,
  type CapabilityRenderMode,
  type CapabilityRenderedBlock,
  type CapabilityRenderedBlockKind,
  type CapabilityRenderedBlockPriority,
  type CapabilitySurface,
  type CapabilityViewPolicy,
  type CapabilityVisibilityInventory,
  type BuildCapabilityViewInput,
  type RenderCapabilityViewInput,
  type BuildCapabilityViewResult,
} from "./capability-view.js";
export {
  buildSkillFirstPolicyBlock,
  deriveSkillRecommendations,
  type SkillRecommendation,
  type SkillRecommendationSet,
  type SkillFirstRuntimeLike,
} from "./skill-first.js";
export { registerEventStream } from "./event-stream.js";
export { registerQualityGate } from "./quality-gate.js";
export { registerLedgerWriter } from "./ledger-writer.js";
export { registerCompletionGuard } from "./completion-guard.js";
export { registerToolSurface, type ToolSurfaceRuntime } from "./tool-surface.js";
export { registerToolResultDistiller } from "./tool-result-distiller.js";
export { applyContextContract, buildContextContractBlock } from "./context-contract.js";
export { createRuntimeChannelTurnBridge } from "./channel-turn-bridge.js";
export { createRuntimeTelegramChannelBridge } from "./telegram-channel-bridge.js";
export {
  CHARS_PER_TOKEN,
  distillToolOutput,
  estimateTokens,
  type ToolOutputDistillation,
} from "./tool-output-distiller.js";
export {
  extractToolResultText,
  resolveToolDisplayStatus,
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
  type ResolveToolDisplayTextInput,
  type ToolDisplayVerdict,
} from "./tool-output-display.js";
export { registerTurnLifecyclePorts, type TurnLifecyclePort } from "./turn-lifecycle-port.js";
