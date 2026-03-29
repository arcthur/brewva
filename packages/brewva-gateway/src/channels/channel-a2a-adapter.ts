import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ChannelA2AAdapter } from "./channel-a2a-runtime-plugin.js";
import type { ChannelCoordinator } from "./coordinator.js";

export function createInstrumentedChannelA2AAdapter(input: {
  runtime: BrewvaRuntime;
  coordinator: Pick<ChannelCoordinator, "a2aSend" | "a2aBroadcast" | "listAgents">;
}): ChannelA2AAdapter {
  return {
    send: async (request) => {
      const result = await input.coordinator.a2aSend(request);
      input.runtime.events.record({
        sessionId: request.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
        payload: {
          fromAgentId: request.fromAgentId,
          toAgentId: request.toAgentId,
          depth: result.depth,
          hops: result.hops,
          correlationId: request.correlationId,
          error: result.error,
        },
      });
      return result;
    },
    broadcast: async (request) => {
      const result = await input.coordinator.a2aBroadcast(request);
      input.runtime.events.record({
        sessionId: request.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
        payload: {
          fromAgentId: request.fromAgentId,
          toAgentIds: request.toAgentIds,
          correlationId: request.correlationId,
          ok: result.ok,
          error: result.error,
        },
      });
      return result;
    },
    listAgents: async (request) => input.coordinator.listAgents(request),
  };
}
