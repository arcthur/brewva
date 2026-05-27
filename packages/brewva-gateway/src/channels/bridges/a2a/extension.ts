import type { A2ABroadcastResult, A2ASendResult } from "@brewva/brewva-tools/contracts";
import { createA2ATools } from "@brewva/brewva-tools/delegation";
import {
  ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "../../../extensions/api.js";

export interface ChannelA2AAdapter {
  send(input: {
    fromSessionId: string;
    fromAgentId?: string;
    toAgentId: string;
    message: string;
    correlationId?: string;
    depth?: number;
    hops?: number;
  }): Promise<A2ASendResult>;
  broadcast(input: {
    fromSessionId: string;
    fromAgentId?: string;
    toAgentIds: string[];
    message: string;
    correlationId?: string;
    depth?: number;
    hops?: number;
  }): Promise<A2ABroadcastResult>;
  listAgents(input?: { includeDeleted?: boolean }): Promise<
    Array<{
      agentId: string;
      status: "active" | "deleted";
    }>
  >;
}

export function createChannelA2AExtension(options: {
  adapter: ChannelA2AAdapter;
}): HostedExtensionPlugin {
  return defineHostedExtensionPlugin({
    name: "channel.a2a",
    capabilities: ["tool_registration.write"],
    advisoryManifest: {
      apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
      slot: "surface.command",
      name: "channel.a2a",
      ambientCapabilityClass: "pure",
      inputs: ["channel.agent_directory"],
      outputs: ["tool_surface"],
    },
    register(extensionApi: HostedExtensionApi) {
      const tools = createA2ATools({
        runtime: {
          orchestration: {
            a2a: options.adapter,
          },
        },
      });
      const ensureRegistered = () => {
        const currentNames = new Set(extensionApi.getAllTools().map((tool) => tool.name));
        for (const tool of tools) {
          if (currentNames.has(tool.name)) continue;
          extensionApi.registerTool(tool);
        }
      };

      extensionApi.on("session_start", () => {
        ensureRegistered();
        return undefined;
      });
    },
  });
}
