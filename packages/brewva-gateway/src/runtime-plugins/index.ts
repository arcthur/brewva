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
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createCompletionGuardLifecycle, registerCompletionGuard } from "./completion-guard.js";
import { createContextTransformLifecycle, registerContextTransform } from "./context-transform.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { createQualityGateLifecycle, registerQualityGate } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import {
  createToolSurfaceLifecycle,
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "./tool-surface.js";
import { registerTurnLifecyclePorts, type TurnLifecyclePort } from "./turn-lifecycle-port.js";

export interface CreateHostedTurnPipelineOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
  orchestration?: BrewvaToolOrchestration;
  managedToolNames?: readonly string[];
  ports?: readonly TurnLifecyclePort[];
}

function buildManagedTools(
  runtime: BrewvaRuntime,
  options: Pick<CreateHostedTurnPipelineOptions, "managedToolNames" | "orchestration">,
): ReturnType<typeof buildBrewvaTools> {
  return buildBrewvaTools({
    runtime,
    orchestration: options.orchestration,
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
    runtime.tools.registerGovernanceDescriptor(tool.name, metadata.governance);
  }
}

function registerHostedPipeline(
  runtime: BrewvaRuntime,
  pi: Parameters<ExtensionFactory>[0],
  tools: ReturnType<typeof buildBrewvaTools>,
  registerTools: boolean,
  userPorts: readonly TurnLifecyclePort[],
): void {
  const toolDefinitionsByName = new Map(tools.map((tool) => [tool.name, tool] as const));
  const contextTransform = createContextTransformLifecycle(pi, runtime);
  const qualityGate = createQualityGateLifecycle(runtime, {
    toolDefinitionsByName,
  });
  const toolSurface = createToolSurfaceLifecycle(pi, runtime, {
    dynamicToolDefinitions: registerTools ? toolDefinitionsByName : undefined,
  });
  const completionGuard = createCompletionGuardLifecycle(pi, runtime);

  pi.on("tool_call", qualityGate.toolCall);
  pi.on("context", contextTransform.context);
  registerEventStream(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  registerTurnLifecyclePorts(pi, [
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
      agentEnd: completionGuard.agentEnd,
      sessionShutdown: completionGuard.sessionShutdown,
    },
    ...userPorts,
  ]);
}

export function createHostedTurnPipeline(
  options: CreateHostedTurnPipelineOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime =
      options.runtime ??
      new BrewvaRuntime({
        ...options,
        governancePort:
          options.governancePort ?? createTrustedLocalGovernancePort({ profile: "team" }),
      });
    const allTools = buildManagedTools(runtime, options);
    const registerTools = options.registerTools !== false;

    registerGovernanceDescriptors(runtime, allTools);
    if (registerTools) {
      for (const tool of allTools) {
        if (getBrewvaToolSurface(tool.name) !== "base") {
          continue;
        }
        pi.registerTool(tool);
      }
    }

    registerHostedPipeline(runtime, pi, allTools, registerTools, options.ports ?? []);
  };
}

export { registerContextTransform } from "./context-transform.js";
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
export { registerTurnLifecyclePorts, type TurnLifecyclePort } from "./turn-lifecycle-port.js";
