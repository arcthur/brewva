import type { ChannelCommandMatch } from "./command/parser.js";
import type { ChannelControlCommand } from "./types.js";

export function resolveChannelControlCommand(
  match: ChannelCommandMatch,
  scopeKey: string,
): ChannelControlCommand | null {
  switch (match.kind) {
    case "none":
    case "error":
      return null;
    case "agents":
      return { kind: "agents", scopeKey };
    case "status":
      return {
        kind: "status",
        scopeKey,
        targetAgentId: match.agentId,
        directory: match.directory,
        top: match.top,
        details: match.details,
      };
    case "steer":
      return {
        kind: "steer",
        scopeKey,
        targetAgentId: match.agentId,
        prompt: match.text,
      };
    case "answer":
      return {
        kind: "answer",
        scopeKey,
        targetAgentId: match.agentId,
        questionId: match.questionId,
        answer: match.answerText,
      };
    case "update":
      return {
        kind: "update",
        scopeKey,
        prompt: match.instructions,
      };
    case "agent-create":
      return {
        kind: "agent-create",
        scopeKey,
        agentId: match.agentId,
        model: match.model,
      };
    case "agent-delete":
      return {
        kind: "agent-delete",
        scopeKey,
        agentId: match.agentId,
      };
    case "focus":
      return {
        kind: "focus",
        scopeKey,
        agentId: match.agentId,
      };
    case "run":
      return {
        kind: "run",
        scopeKey,
        agentIds: [...match.agentIds],
        task: match.task,
      };
    case "discuss":
      return {
        kind: "discuss",
        scopeKey,
        agentIds: [...match.agentIds],
        topic: match.topic,
        maxRounds: match.maxRounds,
      };
    case "route-agent":
      return {
        kind: "route-agent",
        scopeKey,
        agentId: match.agentId,
        task: match.task,
        viaMention: match.viaMention,
      };
  }
  const exhaustive: never = match;
  return exhaustive;
}

export function isPublicChannelControlCommand(command: ChannelControlCommand): boolean {
  switch (command.kind) {
    case "agents":
    case "route-agent":
      return true;
    case "status":
    case "steer":
    case "answer":
    case "update":
    case "agent-create":
    case "agent-delete":
    case "focus":
    case "run":
    case "discuss":
      return false;
  }
  const exhaustive: never = command;
  return exhaustive;
}
