import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { InternalHostPluginApi, BrewvaHostToolInfo } from "@brewva/brewva-substrate";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import {
  deriveSkillRecommendations,
  type SkillClassificationHint,
  type SkillRecommendationSet,
} from "./skill-first.js";

export interface PreparedContextComposerSupport {
  gateStatus: ReturnType<BrewvaHostedRuntimePort["inspect"]["context"]["getCompactionGateStatus"]>;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  skillRecommendations: SkillRecommendationSet;
}

export function prepareContextComposerSupport(input: {
  runtime: BrewvaHostedRuntimePort;
  extensionApi: InternalHostPluginApi;
  sessionId: string;
  prompt: string;
  usage: Parameters<BrewvaHostedRuntimePort["maintain"]["context"]["observeUsage"]>[1];
  classificationHints?: readonly SkillClassificationHint[];
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
    resolveActionPolicy: (toolName) => input.runtime.inspect.tools.getActionPolicy(toolName),
  });
  const skillRecommendations = deriveSkillRecommendations(input.runtime, {
    sessionId: input.sessionId,
    prompt: input.prompt,
    classificationHints: input.classificationHints,
  });
  return {
    gateStatus,
    pendingCompactionReason,
    capabilityView,
    skillRecommendations,
  };
}
