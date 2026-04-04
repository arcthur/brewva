import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { deriveSkillRecommendations, type SkillRecommendationSet } from "./skill-first.js";

export interface PreparedContextComposerSupport {
  gateStatus: ReturnType<BrewvaRuntime["context"]["getCompactionGateStatus"]>;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  skillRecommendations: SkillRecommendationSet;
}

export function prepareContextComposerSupport(input: {
  runtime: BrewvaRuntime;
  extensionApi: ExtensionAPI;
  sessionId: string;
  prompt: string;
  usage: Parameters<BrewvaRuntime["context"]["observeUsage"]>[1];
}): PreparedContextComposerSupport {
  const gateStatus = input.runtime.context.getCompactionGateStatus(input.sessionId, input.usage);
  const pendingCompactionReason = input.runtime.context.getPendingCompactionReason(input.sessionId);
  const allToolsGetter = (input.extensionApi as { getAllTools?: () => ToolInfo[] }).getAllTools;
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
      input.runtime.tools.explainAccess({
        sessionId: input.sessionId,
        toolName,
        usage: input.usage,
      }),
    resolveGovernanceDescriptor: (toolName) =>
      input.runtime.tools.getGovernanceDescriptor(toolName),
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
