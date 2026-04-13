import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaHostPluginApi, BrewvaHostToolInfo } from "@brewva/brewva-substrate";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { deriveSkillRecommendations, type SkillRecommendationSet } from "./skill-first.js";

export interface PreparedContextComposerSupport {
  gateStatus: ReturnType<BrewvaHostedRuntimePort["inspect"]["context"]["getCompactionGateStatus"]>;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  skillRecommendations: SkillRecommendationSet;
}

export function prepareContextComposerSupport(input: {
  runtime: BrewvaHostedRuntimePort;
  extensionApi: BrewvaHostPluginApi;
  sessionId: string;
  prompt: string;
  usage: Parameters<BrewvaHostedRuntimePort["maintain"]["context"]["observeUsage"]>[1];
}): PreparedContextComposerSupport {
  const gateStatus = input.runtime.inspect.context.getCompactionGateStatus(
    input.sessionId,
    input.usage,
  );
  const pendingCompactionReason = input.runtime.inspect.context.getPendingCompactionReason(
    input.sessionId,
  );
  const allToolsGetter = (input.extensionApi as { getAllTools?: () => BrewvaHostToolInfo[] })
    .getAllTools;
  const activeToolsGetter = (input.extensionApi as { getActiveTools?: () => string[] })
    .getActiveTools;
  const capabilityView = buildCapabilityView({
    prompt: input.prompt,
    allTools:
      typeof allToolsGetter === "function"
        ? allToolsGetter.call(input.extensionApi).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))
        : [],
    activeToolNames:
      typeof activeToolsGetter === "function" ? activeToolsGetter.call(input.extensionApi) : [],
    resolveAccess: (toolName) =>
      input.runtime.inspect.tools.explainAccess({
        sessionId: input.sessionId,
        toolName,
        usage: input.usage,
      }),
    resolveGovernanceDescriptor: (toolName) =>
      input.runtime.inspect.tools.getGovernanceDescriptor(toolName),
  });
  const skillRecommendations = deriveSkillRecommendations(input.runtime, {
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  return {
    gateStatus,
    pendingCompactionReason,
    capabilityView,
    skillRecommendations,
  };
}
