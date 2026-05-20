import type { HostedRuntimeAdapterPort } from "../../../hosted/api.js";
import type { ChannelCoordinator } from "../../coordinator.js";
import type { ChannelA2AAdapter } from "./extension.js";

export function createInstrumentedChannelA2AAdapter(input: {
  runtime: HostedRuntimeAdapterPort;
  coordinator: Pick<ChannelCoordinator, "a2aSend" | "a2aBroadcast" | "listAgents">;
}): ChannelA2AAdapter {
  return {
    send: async (request) => {
      const result = await input.coordinator.a2aSend(request);
      const recordA2A = result.ok
        ? input.runtime.ops.channel.a2a.invoked
        : input.runtime.ops.channel.a2a.blocked;
      recordA2A({
        sessionId: request.fromSessionId,
        payload: {
          fromAgentId: request.fromAgentId,
          toAgentId: request.toAgentId,
          depth: result.depth,
          hops: result.hops,
          correlationId: request.correlationId,
          error: result.ok ? undefined : result.error,
        },
      });
      return result;
    },
    broadcast: async (request) => {
      const result = await input.coordinator.a2aBroadcast(request);
      const recordA2A = result.ok
        ? input.runtime.ops.channel.a2a.invoked
        : input.runtime.ops.channel.a2a.blocked;
      recordA2A({
        sessionId: request.fromSessionId,
        payload: {
          fromAgentId: request.fromAgentId,
          toAgentIds: request.toAgentIds,
          correlationId: request.correlationId,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
        },
      });
      return result;
    },
    listAgents: async (request) => input.coordinator.listAgents(request),
  };
}
