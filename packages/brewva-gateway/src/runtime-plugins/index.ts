import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  getExactToolGovernanceDescriptor,
  sameToolGovernanceDescriptor,
  type BrewvaRuntimeOptions,
} from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
  type BrewvaToolOrchestration,
} from "@brewva/brewva-tools";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createCompletionGuardLifecycle, registerCompletionGuard } from "./completion-guard.js";
import { createContextTransformLifecycle, registerContextTransform } from "./context-transform.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { createQualityGateLifecycle } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import { createToolSurfaceLifecycle, registerToolSurface } from "./tool-surface.js";
import { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";

export interface CreateBrewvaExtensionOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
  orchestration?: BrewvaToolOrchestration;
  managedToolNames?: readonly string[];
}

function registerLifecycleHandlers(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  toolDefinitionsByName?: ReadonlyMap<string, ReturnType<typeof buildBrewvaTools>[number]>,
): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const contextTransform = createContextTransformLifecycle(pi, runtime);
  const qualityGate = createQualityGateLifecycle(runtime, {
    toolDefinitionsByName,
  });
  const toolSurface = createToolSurfaceLifecycle(pi, runtime, {
    dynamicToolDefinitions: toolDefinitionsByName,
  });
  const completionGuard = createCompletionGuardLifecycle(pi, runtime);

  hooks.on("input", qualityGate.input);
  hooks.on("tool_call", qualityGate.toolCall);
  registerEventStream(pi, runtime);
  registerTurnLifecycleAdapter(pi, {
    turnStart: [contextTransform.turnStart],
    input: [qualityGate.input],
    context: [contextTransform.context],
    beforeAgentStart: [toolSurface.beforeAgentStart, contextTransform.beforeAgentStart],
    agentEnd: [completionGuard.agentEnd],
    sessionCompact: [contextTransform.sessionCompact],
    sessionShutdown: [contextTransform.sessionShutdown, completionGuard.sessionShutdown],
  });
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  hooks.on("tool_result", qualityGate.toolResult);
}

export function createBrewvaExtension(
  options: CreateBrewvaExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime =
      options.runtime ??
      new BrewvaRuntime({
        ...options,
        governancePort:
          options.governancePort ?? createTrustedLocalGovernancePort({ profile: "team" }),
      });
    const shouldRegisterTools = options.registerTools !== false;
    const allTools = shouldRegisterTools
      ? buildBrewvaTools({
          runtime,
          orchestration: options.orchestration,
          toolNames: options.managedToolNames,
        })
      : [];
    const toolDefinitionsByName = shouldRegisterTools
      ? new Map(allTools.map((tool) => [tool.name, tool] as const))
      : undefined;

    if (shouldRegisterTools) {
      for (const tool of allTools) {
        const metadata = getBrewvaToolMetadata(tool);
        if (metadata?.governance) {
          const exactGovernance = getExactToolGovernanceDescriptor(tool.name);
          if (sameToolGovernanceDescriptor(exactGovernance, metadata.governance)) {
            continue;
          }
          runtime.tools.registerGovernanceDescriptor(tool.name, metadata.governance);
        }
      }
      for (const tool of allTools) {
        if (getBrewvaToolSurface(tool.name) !== "base") continue;
        pi.registerTool(tool);
      }
    }

    registerLifecycleHandlers(pi, runtime, toolDefinitionsByName);
  };
}

export function brewvaExtension(options: CreateBrewvaExtensionOptions = {}): ExtensionFactory {
  return createBrewvaExtension(options);
}

export {
  createRuntimeCoreBridgeExtension,
  registerRuntimeCoreBridge,
} from "./runtime-core-bridge.js";
export { registerContextTransform } from "./context-transform.js";
export { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";
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
