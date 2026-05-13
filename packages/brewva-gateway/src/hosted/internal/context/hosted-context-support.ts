import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { InternalHostPluginApi, BrewvaHostToolInfo } from "@brewva/brewva-substrate/host-api";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";

export interface PreparedHostedContextSupport {
  gateStatus: ReturnType<
    BrewvaHostedRuntimePort["inspect"]["context"]["compaction"]["getGateStatus"]
  >;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
}

export function prepareHostedContextSupport(input: {
  runtime: BrewvaHostedRuntimePort;
  extensionApi: InternalHostPluginApi;
  sessionId: string;
  prompt: string;
  usage: Parameters<BrewvaHostedRuntimePort["operator"]["context"]["usage"]["observe"]>[1];
}): PreparedHostedContextSupport {
  const gateStatus = input.runtime.inspect.context.compaction.getGateStatus(
    input.sessionId,
    input.usage,
  );
  const pendingCompactionReason = input.runtime.inspect.context.compaction.getPendingReason(
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
      input.runtime.inspect.tools.access.explain({
        sessionId: input.sessionId,
        toolName,
        usage: input.usage,
      }),
    resolveActionPolicy: (toolName) => input.runtime.inspect.tools.access.getActionPolicy(toolName),
  });
  return {
    gateStatus,
    pendingCompactionReason,
    capabilityView,
  };
}
