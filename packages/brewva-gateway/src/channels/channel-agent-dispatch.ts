import { BrewvaRuntime, type ToolOutputView } from "@brewva/brewva-runtime";
import type { TurnEnvelope, TurnPart } from "@brewva/brewva-runtime/channels";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { SubscribablePromptSession } from "../session/contracts.js";
import { runHostedThreadLoop } from "../session/hosted-thread-loop.js";
import { resolveThreadLoopProfile } from "../session/thread-loop-profiles.js";
import { toErrorMessage } from "../utils/errors.js";
import { clampText } from "../utils/runtime.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ChannelReplyWriter, ChannelToolTurnOutput } from "./channel-reply-writer.js";
import type { ChannelSessionCoordinator } from "./channel-session-coordinator.js";
import {
  buildChannelSkillPolicyBlock,
  type TelegramChannelSkillPolicyState,
} from "./skill-policy.js";

export interface PromptTurnOutputSession extends SubscribablePromptSession {}

export interface PromptTurnOutputs {
  assistantText: string;
  toolOutputs: ChannelToolTurnOutput[];
}

export interface ChannelDispatchResult {
  ok: true;
  agentId: string;
  responseText: string;
}

export interface ChannelDispatchFailure {
  ok: false;
  agentId: string;
  error: string;
}

export type ChannelDispatchOutcome = ChannelDispatchResult | ChannelDispatchFailure;

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function formatChannelToolTurnOutput(input: ToolOutputView): ChannelToolTurnOutput {
  const status =
    input.verdict === "fail"
      ? "failed"
      : input.verdict === "inconclusive"
        ? "inconclusive"
        : "completed";
  const detail = clampText(input.text, 1200);
  const toolCallId = String(input.toolCallId);
  const toolName = String(input.toolName);
  return {
    toolCallId,
    toolName,
    isError: input.isError,
    verdict: input.verdict,
    text: detail
      ? `Tool ${toolName} (${toolCallId}) ${status}\n${detail}`
      : `Tool ${toolName} (${toolCallId}) ${status}`,
  };
}

function summarizeTurnPart(part: TurnPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "image") {
    return `[image] ${part.uri}`;
  }
  const name = part.name ? ` (${part.name})` : "";
  return `[file${name}] ${part.uri}`;
}

function buildInboundPrompt(turn: TurnEnvelope): string {
  const lines: string[] = [];
  const header = [`[channel:${turn.channel}]`, `conversation:${turn.conversationId}`];
  if (turn.threadId) {
    header.push(`thread:${turn.threadId}`);
  }
  lines.push(header.join(" "));
  lines.push(`turn_kind:${turn.kind}`);

  for (const part of turn.parts) {
    const text = summarizeTurnPart(part).trim();
    if (text) {
      lines.push(text);
    }
  }

  if (turn.kind === "approval" && turn.approval) {
    const actions = turn.approval.actions
      .map((action) => `${action.id} (${action.label})`)
      .join(", ");
    lines.push(`approval_request:${turn.approval.requestId}`);
    lines.push(`approval_title:${turn.approval.title}`);
    if (turn.approval.detail) {
      lines.push(`approval_detail:${turn.approval.detail}`);
    }
    if (actions) {
      lines.push(`approval_actions:${actions}`);
    }
  }

  return lines.join("\n").trim();
}

function combineOutputsForInternalDispatch(outputs: PromptTurnOutputs): string {
  const assistant = normalizeText(outputs.assistantText);
  if (assistant.length > 0) {
    return assistant;
  }
  return outputs.toolOutputs
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

function formatDispatchError(error: unknown): ChannelDispatchFailure {
  return {
    ok: false,
    agentId: "unknown",
    error: toErrorMessage(error),
  };
}

export function canonicalizeInboundTurnSession(
  turn: TurnEnvelope,
  agentSessionId: string,
): TurnEnvelope {
  if (turn.sessionId === agentSessionId) {
    return turn;
  }
  return {
    ...turn,
    sessionId: agentSessionId,
    meta: {
      ...turn.meta,
      channelSessionId: turn.sessionId,
    },
  };
}

export function buildChannelDispatchPrompt(input: {
  turn: TurnEnvelope;
  agentSessionId: string;
  skillPolicyState?: TelegramChannelSkillPolicyState;
}): {
  canonicalTurn: TurnEnvelope;
  prompt: string;
} {
  const canonicalTurn = canonicalizeInboundTurnSession(input.turn, input.agentSessionId);
  const prompt = [
    buildChannelSkillPolicyBlock(canonicalTurn, input.skillPolicyState),
    buildInboundPrompt(canonicalTurn),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    canonicalTurn,
    prompt,
  };
}

export async function collectPromptTurnOutputs(
  session: PromptTurnOutputSession,
  prompt: string,
  options?: {
    runtime?: BrewvaRuntime;
    sessionId?: string;
    turnId?: string;
  },
): Promise<PromptTurnOutputs> {
  const output = await runHostedThreadLoop({
    session,
    prompt,
    profile: resolveThreadLoopProfile({ source: "channel" }),
    runtime: options?.runtime,
    sessionId: options?.sessionId,
    turnId: options?.turnId,
  });
  if (output.status !== "completed") {
    throw new Error(`channel_thread_loop_${output.status}`);
  }
  return {
    assistantText: output.assistantText,
    toolOutputs: output.toolOutputs.map(formatChannelToolTurnOutput),
  };
}

export function createChannelAgentDispatch(input: {
  registry: Pick<AgentRegistry, "touchAgent">;
  sessionCoordinator: Pick<
    ChannelSessionCoordinator,
    "getOrCreateSession" | "enqueueSessionTask" | "touchSession" | "nextOutboundSequence"
  >;
  replyWriter: Pick<ChannelReplyWriter, "sendAgentOutputs">;
  collectPromptTurnOutputs: (
    session: PromptTurnOutputSession,
    prompt: string,
    options?: {
      runtime?: BrewvaRuntime;
      sessionId?: string;
      turnId?: string;
    },
  ) => Promise<PromptTurnOutputs>;
  skillPolicyState?: TelegramChannelSkillPolicyState;
}) {
  const executePromptForAgent = async (dispatch: {
    scopeKey: string;
    agentId: string;
    prompt: string;
    reason: "run" | "discuss" | "a2a";
    turn: TurnEnvelope;
    correlationId?: string;
    fromAgentId?: string;
    fromSessionId?: string;
    depth?: number;
    hops?: number;
  }): Promise<ChannelDispatchOutcome> => {
    try {
      const state = await input.sessionCoordinator.getOrCreateSession(
        dispatch.scopeKey,
        dispatch.agentId,
        dispatch.turn,
      );
      const outputs = await input.sessionCoordinator.enqueueSessionTask(state, async () => {
        input.sessionCoordinator.touchSession(state);
        return input.collectPromptTurnOutputs(state.session, dispatch.prompt, {
          runtime: state.runtime,
          sessionId: state.agentSessionId,
          turnId: dispatch.turn.turnId,
        });
      });
      await input.registry.touchAgent(dispatch.agentId, Date.now(), true);
      return {
        ok: true,
        agentId: dispatch.agentId,
        responseText: combineOutputsForInternalDispatch(outputs),
      };
    } catch (error) {
      return {
        ...formatDispatchError(error),
        agentId: dispatch.agentId,
      };
    }
  };

  const processUserTurnOnAgent = async (
    turn: TurnEnvelope,
    _walId: string,
    scopeKey: string,
    targetAgentId: string,
  ): Promise<void> => {
    const state = await input.sessionCoordinator.getOrCreateSession(scopeKey, targetAgentId, turn);
    const { canonicalTurn, prompt } = buildChannelDispatchPrompt({
      turn,
      agentSessionId: state.agentSessionId,
      skillPolicyState: input.skillPolicyState,
    });

    if (!prompt) {
      return;
    }
    recordRuntimeEvent(state.runtime, {
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_dispatch_start",
      payload: {
        turnId: canonicalTurn.turnId,
        kind: canonicalTurn.kind,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
      },
    });

    const outputs = await input.sessionCoordinator.enqueueSessionTask(state, async () => {
      input.sessionCoordinator.touchSession(state);
      return input.collectPromptTurnOutputs(state.session, prompt, {
        runtime: state.runtime,
        sessionId: state.agentSessionId,
        turnId: canonicalTurn.turnId,
      });
    });
    await input.registry.touchAgent(state.agentId, Date.now(), true);

    recordRuntimeEvent(state.runtime, {
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_dispatch_end",
      payload: {
        turnId: canonicalTurn.turnId,
        kind: canonicalTurn.kind,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
        assistantChars: normalizeText(outputs.assistantText).length,
        toolTurns: outputs.toolOutputs.length,
      },
    });
    const outboundTurnsSent = await input.replyWriter.sendAgentOutputs({
      runtime: state.runtime,
      inbound: canonicalTurn,
      agentSessionId: state.agentSessionId,
      agentId: state.agentId,
      assistantText: outputs.assistantText,
      toolOutputs: outputs.toolOutputs,
      nextSequence: () => input.sessionCoordinator.nextOutboundSequence(state),
    });

    recordRuntimeEvent(state.runtime, {
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_outbound_complete",
      payload: {
        turnId: canonicalTurn.turnId,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
        outboundTurnsSent,
        toolTurns: outputs.toolOutputs.length,
        hasAssistantTurn: normalizeText(outputs.assistantText).length > 0,
      },
    });
  };

  return {
    executePromptForAgent,
    processUserTurnOnAgent,
  };
}
