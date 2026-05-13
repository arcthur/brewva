import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { ChannelCoordinator } from "../../coordinator.js";
import type { ChannelA2AAdapter } from "./extension.js";

export function createInstrumentedChannelA2AAdapter(input: {
  runtime: BrewvaHostedRuntimePort;
  coordinator: Pick<ChannelCoordinator, "a2aSend" | "a2aBroadcast" | "listAgents">;
}): ChannelA2AAdapter {
  return {
    send: async (request) => {
      const result = await input.coordinator.a2aSend(request);
      input.runtime.extensions.hosted.events.record({
        sessionId: request.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
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
      input.runtime.extensions.hosted.events.record({
        sessionId: request.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
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
