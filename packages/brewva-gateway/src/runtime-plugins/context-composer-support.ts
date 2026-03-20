import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import type { ComposedContextBlock } from "./context-composer.js";
import { resolveDelegationRecommendationBlock } from "./delegation-recommendation.js";

export interface PreparedContextComposerSupport {
  gateStatus: ReturnType<BrewvaRuntime["context"]["getCompactionGateStatus"]>;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  delegationRecommendation: ComposedContextBlock | null;
}

export function prepareContextComposerSupport(input: {
  runtime: BrewvaRuntime;
  pi: ExtensionAPI;
  sessionId: string;
  prompt: string;
  usage: Parameters<BrewvaRuntime["context"]["observeUsage"]>[1];
}): PreparedContextComposerSupport {
  const gateStatus = input.runtime.context.getCompactionGateStatus(input.sessionId, input.usage);
  const pendingCompactionReason = input.runtime.context.getPendingCompactionReason(input.sessionId);
  const allToolsGetter = (input.pi as { getAllTools?: () => ToolInfo[] }).getAllTools;
  const activeToolsGetter = (input.pi as { getActiveTools?: () => string[] }).getActiveTools;
  const capabilityView = buildCapabilityView({
    prompt: input.prompt,
    allTools:
      typeof allToolsGetter === "function"
        ? allToolsGetter.call(input.pi).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))
        : [],
    activeToolNames:
      typeof activeToolsGetter === "function" ? activeToolsGetter.call(input.pi) : [],
    resolveAccess: (toolName) =>
      input.runtime.tools.explainAccess({
        sessionId: input.sessionId,
        toolName,
        usage: input.usage,
      }),
    resolveGovernanceDescriptor: (toolName) =>
      input.runtime.tools.getGovernanceDescriptor(toolName),
  });
  const delegationRecommendation = resolveDelegationRecommendationBlock({
    runtime: input.runtime,
    sessionId: input.sessionId,
    prompt: input.prompt,
    capabilityView,
    gateRequired: gateStatus.required,
    pendingCompactionReason,
  });

  return {
    gateStatus,
    pendingCompactionReason,
    capabilityView,
    delegationRecommendation,
  };
}
