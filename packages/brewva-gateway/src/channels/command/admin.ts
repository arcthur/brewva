import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type { AgentRegistry } from "../agent-registry.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelCoordinator } from "../coordinator.js";
import { isOwnerAuthorized } from "../policy/acl.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

export async function handleChannelAgentsCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "agents" }>;
  turn: TurnEnvelope;
  replyWriter: ChannelReplyWriter;
  renderAgentsSnapshot(scopeKey: string): string;
}): Promise<ChannelCommandDispatchResult> {
  await input.replyWriter.sendControllerReply(
    input.turn,
    input.command.scopeKey,
    input.renderAgentsSnapshot(input.command.scopeKey),
  );
  return { handled: true };
}

export async function handleChannelAgentCreateCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "agent-create" }>;
  turn: TurnEnvelope;
  registry: AgentRegistry;
  replyWriter: ChannelReplyWriter;
  runtime: BrewvaRuntime;
}): Promise<ChannelCommandDispatchResult> {
  const created = await input.registry.createAgent({
    requestedAgentId: input.command.agentId,
    model: input.command.model,
  });
  if (!created.ok) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Failed to create agent: ${created.reason}`,
    );
  } else {
    input.runtime.extensions.hosted.events.record({
      sessionId: input.turn.sessionId,
      type: "channel_agent_created",
      payload: {
        scopeKey: input.command.scopeKey,
        agentId: created.agent.agentId,
        model: created.agent.model,
      },
    });
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Created agent @${created.agent.agentId}${created.agent.model ? ` (model=${created.agent.model})` : ""}.`,
    );
  }
  return { handled: true };
}

export async function handleChannelAgentDeleteCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "agent-delete" }>;
  turn: TurnEnvelope;
  registry: AgentRegistry;
  replyWriter: ChannelReplyWriter;
  runtime: BrewvaRuntime;
  cleanupAgentSessions(agentId: string): Promise<void>;
  disposeAgentRuntime(agentId: string): boolean;
}): Promise<ChannelCommandDispatchResult> {
  const deleted = await input.registry.softDeleteAgent(input.command.agentId);
  if (!deleted.ok) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Failed to delete agent: ${deleted.reason}`,
    );
  } else {
    await input.cleanupAgentSessions(input.command.agentId);
    input.disposeAgentRuntime(input.command.agentId);
    input.runtime.extensions.hosted.events.record({
      sessionId: input.turn.sessionId,
      type: "channel_agent_deleted",
      payload: {
        scopeKey: input.command.scopeKey,
        agentId: input.command.agentId,
      },
    });
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Deleted agent @${input.command.agentId} (soft delete).`,
    );
  }
  return { handled: true };
}

export async function handleChannelFocusCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "focus" }>;
  turn: TurnEnvelope;
  registry: AgentRegistry;
  replyWriter: ChannelReplyWriter;
  runtime: BrewvaRuntime;
}): Promise<ChannelCommandDispatchResult> {
  const focused = await input.registry.setFocus(input.command.scopeKey, input.command.agentId);
  if (!focused.ok) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Failed to set focus: ${focused.reason}`,
    );
  } else {
    input.runtime.extensions.hosted.events.record({
      sessionId: input.turn.sessionId,
      type: "channel_focus_changed",
      payload: {
        scopeKey: input.command.scopeKey,
        agentId: focused.agentId,
        source: "command",
      },
    });
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Focus set to @${focused.agentId}.`,
    );
  }
  return { handled: true };
}

export async function handleChannelRunCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "run" }>;
  turn: TurnEnvelope;
  coordinator: Pick<ChannelCoordinator, "fanOut">;
  replyWriter: ChannelReplyWriter;
  runtime: BrewvaRuntime;
}): Promise<ChannelCommandDispatchResult> {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.turn.sessionId,
    type: "channel_fanout_started",
    payload: {
      scopeKey: input.command.scopeKey,
      targets: input.command.agentIds,
    },
  });
  const result = await input.coordinator.fanOut({
    agentIds: input.command.agentIds,
    task: input.command.task,
    scopeKey: input.command.scopeKey,
  });
  const lines = [
    result.ok ? "Fan-out completed." : `Fan-out failed: ${result.error}`,
    ...result.results.map((entry) =>
      entry.ok
        ? `- @${entry.agentId}: ${entry.responseText || "(empty)"}`
        : `- @${entry.agentId}: ERROR ${entry.error}`,
    ),
  ];
  input.runtime.extensions.hosted.events.record({
    sessionId: input.turn.sessionId,
    type: "channel_fanout_finished",
    payload: {
      scopeKey: input.command.scopeKey,
      targets: input.command.agentIds,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    },
  });
  await input.replyWriter.sendControllerReply(input.turn, input.command.scopeKey, lines.join("\n"));
  return { handled: true };
}

export async function handleChannelDiscussCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "discuss" }>;
  turn: TurnEnvelope;
  coordinator: Pick<ChannelCoordinator, "discuss">;
  replyWriter: ChannelReplyWriter;
  runtime: BrewvaRuntime;
}): Promise<ChannelCommandDispatchResult> {
  const discussion = await input.coordinator.discuss({
    agentIds: input.command.agentIds,
    topic: input.command.topic,
    maxRounds: input.command.maxRounds,
    scopeKey: input.command.scopeKey,
  });
  const lines = [
    discussion.ok
      ? `Discussion completed (stoppedEarly=${discussion.stoppedEarly}).`
      : `Discussion failed: ${discussion.reason}`,
  ];
  for (const round of discussion.rounds) {
    input.runtime.extensions.hosted.events.record({
      sessionId: input.turn.sessionId,
      type: "channel_discussion_round",
      payload: {
        scopeKey: input.command.scopeKey,
        round: round.round,
        agentId: round.agentId,
      },
    });
    lines.push(`- r${round.round} @${round.agentId}: ${round.responseText || "(empty)"}`);
  }
  await input.replyWriter.sendControllerReply(input.turn, input.command.scopeKey, lines.join("\n"));
  return { handled: true };
}

export async function handleChannelRouteAgentCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "route-agent" }>;
  turn: TurnEnvelope;
  registry: AgentRegistry;
  runtime: BrewvaRuntime;
  replyWriter: ChannelReplyWriter;
  orchestrationOwners: string[];
  aclModeWhenOwnersEmpty: "open" | "closed";
}): Promise<ChannelCommandDispatchResult> {
  if (!input.registry.isActive(input.command.agentId)) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Mention unavailable: agent @${input.command.agentId} is not active in this workspace.`,
    );
    return { handled: true };
  }
  const authorized = isOwnerAuthorized(
    input.turn,
    input.orchestrationOwners,
    input.aclModeWhenOwnersEmpty,
  );
  if (authorized) {
    const focused = await input.registry.setFocus(input.command.scopeKey, input.command.agentId);
    if (focused.ok) {
      input.runtime.extensions.hosted.events.record({
        sessionId: input.turn.sessionId,
        type: "channel_focus_changed",
        payload: {
          scopeKey: input.command.scopeKey,
          agentId: focused.agentId,
          source: "mention",
        },
      });
    }
  }
  return {
    handled: false,
    routeAgentId: input.command.agentId,
    routeTask: input.command.task,
  };
}
