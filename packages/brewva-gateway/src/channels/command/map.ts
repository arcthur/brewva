import { planMapFrontier, type PlanMapState } from "@brewva/brewva-vocabulary/plan-map";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelRuntimeSessionPort } from "../session/coordinator.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

function formatPlanMapReply(map: PlanMapState): string {
  const frontier = planMapFrontier(map);
  return [
    `Map @${map.mapId}: ${map.destination}`,
    `Frontier (${frontier.length}): ${frontier.map((ticket) => ticket.title).join(", ") || "—"}`,
  ].join("\n");
}

/**
 * The `/map` channel command: a thin, owner-gated operator surface over the durable
 * `planMap` runtime capability, mirroring `/goal` but keyed by an explicit `mapId`
 * (the map is cross-session; there is no per-scope "active map" to hold). Read
 * (`show`) and the mutations (`chart` / `take` / `resolve`) all route to the same
 * capability the managed tools use.
 */
export async function handleChannelMapCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "map" }>;
  turn: TurnEnvelope;
  replyWriter: ChannelReplyWriter;
  targetAgentId: string;
  isTargetActive: boolean;
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
}): Promise<ChannelCommandDispatchResult> {
  const reply = (message: string, status: string, extra?: Record<string, unknown>) =>
    input.replyWriter.sendControllerReply(input.turn, input.command.scopeKey, message, {
      command: "map",
      agentId: input.targetAgentId,
      status,
      ...extra,
    });

  if (!input.isTargetActive) {
    await reply(
      `Map unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      "agent_not_active",
    );
    return { handled: true };
  }
  const targetSession = input.openLiveSession(input.command.scopeKey, input.targetAgentId);
  if (!targetSession) {
    await reply(
      `Map unavailable: no live session exists for @${input.targetAgentId} in this conversation.`,
      "session_not_found",
    );
    return { handled: true };
  }

  const sessionId = targetSession.agentSessionId;
  const planMap = targetSession.operatorRuntime.ops.planMap;
  const command = input.command.command;

  if (command.kind === "show") {
    const map = planMap.state.get(command.mapId);
    await reply(
      map ? formatPlanMapReply(map) : `No plan map ${command.mapId}.`,
      map ? "ok" : "map_not_found",
      {
        mapId: command.mapId,
      },
    );
    return { handled: true };
  }

  const result = (() => {
    if (command.kind === "chart") {
      return planMap.map.create(command.mapId, { sessionId, destination: command.destination });
    }
    if (command.kind === "take") {
      // ticketId is optional: the controller takes the first frontier ticket when it
      // is omitted (the "take next" policy is single-sourced there).
      return planMap.ticket.claim(command.mapId, { sessionId, ticketId: command.ticketId });
    }
    return planMap.ticket.resolve(command.mapId, {
      sessionId,
      ticketId: command.ticketId,
      answer: command.answer,
    });
  })();

  await reply(
    result.ok
      ? formatPlanMapReply(result.map)
      : `Map command rejected for @${input.targetAgentId}: ${result.reason}.`,
    result.ok ? "ok" : "rejected",
    { mapId: command.mapId, action: command.kind },
  );
  return { handled: true };
}
