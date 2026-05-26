import type { InternalHostPlugin, InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import { defineInternalHostPlugin } from "@brewva/brewva-substrate/host-api";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { BrewvaToolOrchestration } from "@brewva/brewva-tools/contracts";
import { createBrewvaToolCatalog, getBrewvaToolSurface } from "@brewva/brewva-tools/registry";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import { createContextTransformLifecycle } from "../context/context-transform.js";
import { registerEventStream } from "../context/evidence/event-stream.js";
import { registerLedgerWriter } from "../context/evidence/ledger-writer.js";
import { createReadPathRecoveryLifecycle } from "../context/read-path-recovery.js";
import {
  createLocalHookManager,
  type LocalHookPort,
} from "../turn-adapter/lifecycle/local-hook-port.js";
import { createRuntimeTurnClockStore } from "../turn-adapter/lifecycle/runtime-turn-clock.js";
import {
  registerTurnLifecyclePorts,
  type TurnLifecyclePort,
} from "../turn-adapter/lifecycle/turn-lifecycle-port.js";
import {
  createHostedRuntimeAdapter,
  getRuntimeOpsPort,
  toHostedRuntimeAdapterPort,
  toToolRuntimeAdapterPort,
  type HostedRuntimeAdapterOptions,
  type HostedRuntimeAdapterPort,
} from "./runtime-ports.js";
import { createSkillSelectionLifecycle } from "./skills/skill-selection.js";
import {
  createHostedToolExecutionCoordinator,
  type HostedToolExecutionCoordinator,
  wrapToolDefinitionsWithHostedExecutionTraits,
} from "./tools/execution-traits.js";
import { createQualityGateLifecycle } from "./tools/quality-gate.js";
import { registerToolResultDistiller } from "./tools/tool-result-distiller.js";
import { createToolSurfaceLifecycle, type ToolSurfaceRuntime } from "./tools/tool-surface.js";

export {
  HOSTED_WORKBENCH_CONTEXT_MESSAGE_TYPE,
  createHostedWorkbenchContextController,
  type HostedContextSessionManager,
  type HostedWorkbenchContextController,
  type HostedWorkbenchContextInput,
  type HostedWorkbenchContextMessageDetails,
  type HostedWorkbenchContextOptions,
  type HostedWorkbenchContextResult,
} from "../context/workbench-context.js";
export {
  createContextTransformLifecycle,
  registerContextTransform,
} from "../context/context-transform.js";
export {
  analyzeReadPathRecoveryState,
  createReadPathRecoveryLifecycle,
  isReadPathVerified,
  recordReadPathGuardWarning,
  type ReadPathRecoveryState,
} from "../context/read-path-recovery.js";
export { applyContextContract, buildContextContractBlock } from "../context/context-contract.js";
export {
  buildCapabilityView,
  renderCapabilityView,
  type BuildCapabilityViewInput,
  type BuildCapabilityViewResult,
  type CapabilityAccessDecision,
  type CapabilityDetail,
  type CapabilityHintId,
  type CapabilityPolicyId,
  type CapabilityRenderMode,
  type CapabilityRenderedBlock,
  type CapabilityRenderedBlockKind,
  type CapabilityRenderedBlockPriority,
  type CapabilitySurface,
  type CapabilityView,
  type CapabilityViewPolicy,
  type CapabilityVisibilityInventory,
  type RenderCapabilityViewInput,
} from "../context/capability-view.js";
export {
  buildContextComposedEventPayload,
  makeHostedContextBlock,
  renderHostedContextBlocks,
  type ContextComposedEventPayload,
  type HostedContextBlock,
  type HostedContextRenderResult,
} from "../context/hosted-context-blocks.js";
export {
  AUTO_COMPACTION_WATCHDOG_ERROR,
  createHostedContextTelemetry,
  type HostedContextTelemetry,
} from "../context/hosted-context-telemetry.js";
export {
  buildContextEvidenceReport,
  persistContextEvidenceReport,
  readContextEvidenceRecords,
  readContextEvidenceSamples,
  recordPromptStabilityEvidence,
  recordProviderCacheObservationEvidence,
  recordTransientReductionEvidence,
  type ContextEvidenceAggregateReport,
  type ContextEvidenceArtifactRef,
  type ContextEvidencePromotionReadiness,
  type ContextEvidenceReport,
  type ContextEvidenceReportOptions,
  type ContextEvidenceSample,
  type ContextEvidenceSessionReport,
  type PromptStabilityEvidenceSample,
  type ProviderCacheObservationEvidenceSample,
  type TransientReductionEvidenceSample,
} from "../context/evidence/context-evidence.js";
export { registerEventStream } from "../context/evidence/event-stream.js";
export { registerLedgerWriter } from "../context/evidence/ledger-writer.js";
export {
  createRuntimeTurnClockStore,
  type RuntimeTurnClockStore,
} from "../turn-adapter/lifecycle/runtime-turn-clock.js";
export {
  createLocalHookManager,
  type LocalHookManager,
  type LocalHookNote,
  type LocalHookPhase,
  type LocalHookPort,
  type LocalHookPostReceiptInput,
  type LocalHookPostReceiptResult,
  type LocalHookPostRollbackInput,
  type LocalHookPostRollbackResult,
  type LocalHookPostTerminalInput,
  type LocalHookPostTerminalResult,
  type LocalHookPreAdmissionInput,
  type LocalHookPreAdmissionResult,
  type LocalHookPreEffectInput,
  type LocalHookPreEffectResult,
  type LocalHookRecommendation,
  type LocalHookResult,
} from "../turn-adapter/lifecycle/local-hook-port.js";
export {
  registerTurnLifecyclePorts,
  type TurnLifecyclePort,
} from "../turn-adapter/lifecycle/turn-lifecycle-port.js";
export { createQualityGateLifecycle, registerQualityGate } from "./tools/quality-gate.js";
export { registerToolResultDistiller } from "./tools/tool-result-distiller.js";
export {
  createToolSurfaceLifecycle,
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "./tools/tool-surface.js";
export {
  buildSkillShortlistContextForPrompt,
  createSkillSelectionLifecycle,
  describeAvailableSkillForDisplay,
  explicitSkillMentionNamesFromReceipt,
  formatSkillSelectionSection,
  readLatestSkillSelectionReceipt,
  skillSelectionSummaryForTrace,
  type AvailableSkillPromptContext,
  type ExplicitSkillMention,
  type SkillSelectionLifecycle,
  type SkillSelectionReceipt,
  type SkillSelectionResult,
  type SkillSelectionRuntime,
} from "./skills/skill-selection.js";
export {
  distillToolOutput,
  estimateTokens,
  type ToolOutputDistillation,
} from "./tools/tool-output-distiller.js";
export {
  extractToolResultText,
  resolveToolDisplay,
  resolveToolDisplayStatus,
  resolveToolDisplayVerdict,
  type ResolveToolDisplayTextInput,
  type ResolvedToolDisplay,
  type ToolDisplayVerdict,
} from "./tools/tool-output-display.js";

export interface CreateHostedBehaviorHostAdapterOptions extends HostedRuntimeAdapterOptions {
  runtime?: HostedRuntimeAdapterPort;
  registerTools?: boolean;
  orchestration?: BrewvaToolOrchestration;
  delegationStore?: HostedDelegationStore;
  managedToolNames?: readonly string[];
  ports?: readonly TurnLifecyclePort[];
  localHooks?: readonly LocalHookPort[];
  toolExecutionCoordinator?: HostedToolExecutionCoordinator;
  hostedToolDefinitionsByName?: ReadonlyMap<string, BrewvaToolDefinition>;
}

function assertHostedBehaviorHostAdapterRuntimeShape(
  _options: CreateHostedBehaviorHostAdapterOptions,
): void {}

function buildManagedTools(
  runtime: HostedRuntimeAdapterPort,
  options: Pick<
    CreateHostedBehaviorHostAdapterOptions,
    "managedToolNames" | "orchestration" | "delegationStore"
  >,
): ReturnType<typeof buildBrewvaTools> {
  const delegationStore = options.delegationStore;
  const delegation = delegationStore
    ? {
        listRuns: (sessionId: string, query?: Parameters<HostedDelegationStore["listRuns"]>[1]) =>
          delegationStore.listRunsFromReadModel(sessionId, query),
        listPendingOutcomes: (
          sessionId: string,
          query?: Parameters<HostedDelegationStore["listPendingOutcomes"]>[1],
        ) => delegationStore.listPendingOutcomesFromReadModel(sessionId, query),
        inspect: (sessionId: string) => delegationStore.inspect(sessionId),
      }
    : undefined;
  return buildBrewvaTools({
    runtime: {
      ...toToolRuntimeAdapterPort(runtime),
    },
    orchestration: options.orchestration,
    delegation,
    toolNames: options.managedToolNames,
  });
}

function installHostedBehavior(
  runtime: HostedRuntimeAdapterPort,
  hostApi: InternalHostPluginApi,
  tools: ReturnType<typeof buildBrewvaTools>,
  extraToolDefinitionsByName: ReadonlyMap<string, BrewvaToolDefinition>,
  registerTools: boolean,
  delegationStore: HostedDelegationStore | undefined,
  userPorts: readonly TurnLifecyclePort[],
  localHooks: readonly LocalHookPort[],
): void {
  const toolCatalog = createBrewvaToolCatalog(
    [...extraToolDefinitionsByName.values(), ...tools],
    "managed",
  );
  const toolDefinitionsByName = new Map<string, BrewvaToolDefinition>();
  for (const entry of toolCatalog.list()) {
    if (entry.definition) {
      toolDefinitionsByName.set(entry.descriptor.name, entry.definition as BrewvaToolDefinition);
    }
  }
  const turnClock = createRuntimeTurnClockStore();
  const toolSurfaceRuntime: ToolSurfaceRuntime = {
    identity: {
      cwd: runtime.identity.cwd,
      workspaceRoot: runtime.identity.workspaceRoot,
    },
    config: runtime.config,
    ops: getRuntimeOpsPort(runtime),
  };
  const localHookManager = createLocalHookManager({
    extensionApi: hostApi,
    runtime,
    hooks: localHooks,
  });
  const contextTransform = createContextTransformLifecycle(hostApi, runtime, {
    delegationStore,
    turnClock,
  });
  const qualityGate = createQualityGateLifecycle(runtime, {
    toolDefinitionsByName,
  });
  const skillSelection = createSkillSelectionLifecycle(runtime);
  const toolSurface = createToolSurfaceLifecycle(hostApi, toolSurfaceRuntime, {
    dynamicToolDefinitions: registerTools ? toolDefinitionsByName : undefined,
  });
  const readPathRecovery = createReadPathRecoveryLifecycle(runtime);

  hostApi.on("tool_call", qualityGate.toolCall);
  hostApi.on("context", contextTransform.context);
  registerEventStream(hostApi, runtime, turnClock, {
    toolDefinitionsByName,
  });
  registerLedgerWriter(hostApi, runtime);
  registerToolResultDistiller(hostApi, runtime);
  registerTurnLifecyclePorts(hostApi, [
    localHookManager.lifecycle,
    {
      beforeAgentStart: skillSelection.beforeAgentStart,
    },
    {
      turnStart: contextTransform.turnStart,
      sessionCompact: contextTransform.sessionCompact,
      sessionShutdown: contextTransform.sessionShutdown,
    },
    {
      beforeAgentStart: toolSurface.beforeAgentStart,
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
    ...userPorts,
  ]);
}

export function createHostedBehaviorHostAdapter(
  options: CreateHostedBehaviorHostAdapterOptions = {},
): InternalHostPlugin {
  return defineInternalHostPlugin({
    name: "hosted_behavior",
    capabilities: [
      "tool_registration.write",
      "tool_surface.write",
      "system_prompt.write",
      "context_messages.write",
      "provider_payload.write",
      "input_parts.write",
      "tool_call.block",
      "tool_result.write",
      "assistant_message.enqueue",
    ],
    register(hostApi) {
      assertHostedBehaviorHostAdapterRuntimeShape(options);
      const runtime = toHostedRuntimeAdapterPort(
        options.runtime ?? createHostedRuntimeAdapter(options),
      );
      const executionCoordinator =
        options.toolExecutionCoordinator ?? createHostedToolExecutionCoordinator();
      const allTools =
        wrapToolDefinitionsWithHostedExecutionTraits(
          buildManagedTools(runtime, options),
          executionCoordinator,
        ) ?? [];
      const registerTools = options.registerTools !== false;

      if (registerTools) {
        for (const tool of allTools) {
          if (getBrewvaToolSurface(tool.name) !== "base") {
            continue;
          }
          hostApi.registerTool(tool);
        }
      }

      installHostedBehavior(
        runtime,
        hostApi,
        allTools,
        options.hostedToolDefinitionsByName ?? new Map<string, BrewvaToolDefinition>(),
        registerTools,
        options.delegationStore,
        options.ports ?? [],
        options.localHooks ?? [],
      );
    },
  });
}
