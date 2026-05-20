import type { InternalHostPluginApi, BrewvaHostToolInfo } from "@brewva/brewva-substrate/host-api";
import {
  explainRuntimeToolAccess,
  getRuntimeCompactionGateStatus,
  getRuntimePendingCompactionReason,
  getRuntimeToolActionPolicy,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import { buildCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";

export interface PreparedHostedContextSupport {
  gateStatus: ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["getGateStatus"]>;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
}

export function prepareHostedContextSupport(input: {
  runtime: HostedRuntimeAdapterPort;
  extensionApi: InternalHostPluginApi;
  sessionId: string;
  prompt: string;
  usage: Parameters<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["observe"]>[1];
}): PreparedHostedContextSupport {
  const gateStatus = getRuntimeCompactionGateStatus(input.runtime, input.sessionId, input.usage);
  const pendingCompactionReason = getRuntimePendingCompactionReason(input.runtime, input.sessionId);
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
      explainRuntimeToolAccess(input.runtime, {
        sessionId: input.sessionId,
        toolName,
        usage: input.usage,
      }),
    resolveActionPolicy: (toolName) => getRuntimeToolActionPolicy(input.runtime, toolName),
  });
  return {
    gateStatus,
    pendingCompactionReason,
    capabilityView,
  };
}
