import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope, TurnPart } from "@brewva/brewva-runtime/channels";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  resolveToolDisplayStatus,
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
} from "../runtime-plugins/index.js";
import { sendPromptWithCompactionRecovery } from "../session/compaction-recovery.js";
import type { SubscribablePromptSession } from "../session/contracts.js";
import { preparePendingSessionReasoningRevertResume } from "../session/reasoning-revert-recovery.js";
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
  ok: boolean;
  agentId: string;
  responseText: string;
  error?: string;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function extractMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function asToolExecutionEndEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
} | null {
  if (event.type !== "tool_execution_end") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    result?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    isError: candidate.isError === true,
    result: candidate.result,
  };
}

function formatToolTurnOutput(input: {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
}): ChannelToolTurnOutput {
  const verdict = resolveToolDisplayVerdict({
    isError: input.isError,
    result: input.result,
  });
  const status = resolveToolDisplayStatus({
    isError: input.isError,
    result: input.result,
  });
  const detail = clampText(
    resolveToolDisplayText({
      toolName: input.toolName,
      isError: input.isError,
      result: input.result,
    }),
    1200,
  );
  const text = detail
    ? `Tool ${input.toolName} (${input.toolCallId}) ${status}\n${detail}`
    : `Tool ${input.toolName} (${input.toolCallId}) ${status}`;
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    isError: input.isError,
    verdict,
    text,
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

function formatDispatchError(error: unknown): ChannelDispatchResult {
  return {
    ok: false,
    agentId: "unknown",
    responseText: "",
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
  let latestAssistantText = "";
  const toolOutputs: ChannelToolTurnOutput[] = [];
  const seenToolCallIds = new Set<string>();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const toolEvent = asToolExecutionEndEvent(event);
    if (toolEvent) {
      if (seenToolCallIds.has(toolEvent.toolCallId)) {
        return;
      }
      seenToolCallIds.add(toolEvent.toolCallId);
      toolOutputs.push(formatToolTurnOutput(toolEvent));
      return;
    }

    if (event.type === "message_end") {
      const message = (event as { message?: unknown }).message;
      if (extractMessageRole(message) !== "assistant") return;
      const text = normalizeText(extractMessageText(message));
      if (text) {
        latestAssistantText = text;
      }
    }
  });

  try {
    let activePrompt = prompt;
    let preparedReasoningResume: Awaited<
      ReturnType<typeof preparePendingSessionReasoningRevertResume>
    > | null = null;
    for (;;) {
      try {
        await sendPromptWithCompactionRecovery(session, activePrompt, {
          runtime: options?.runtime,
          sessionId: options?.sessionId,
        });
        preparedReasoningResume?.complete();
        return {
          assistantText: latestAssistantText,
          toolOutputs,
        };
      } catch (error) {
        preparedReasoningResume?.fail(error);
        preparedReasoningResume = null;
        const pendingReasoningResume =
          options?.runtime && options.sessionId
            ? await preparePendingSessionReasoningRevertResume(session, {
                runtime: options.runtime,
                sessionId: options.sessionId,
              })
            : null;
        if (!pendingReasoningResume) {
          throw error;
        }
        latestAssistantText = "";
        toolOutputs.length = 0;
        seenToolCallIds.clear();
        preparedReasoningResume = pendingReasoningResume;
        activePrompt = pendingReasoningResume.prompt;
      }
    }
  } finally {
    unsubscribe();
  }
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
  }): Promise<ChannelDispatchResult> => {
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
