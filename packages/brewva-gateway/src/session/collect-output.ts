import {
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { ToolDisplayVerdict } from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { sendPromptWithCompactionRecovery } from "./compaction-recovery.js";
import type { SubscribablePromptSession } from "./contracts.js";

export interface GatewayToolOutput {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  verdict: ToolDisplayVerdict;
  text: string;
}

export interface SessionPromptOutput {
  assistantText: string;
  toolOutputs: GatewayToolOutput[];
  attemptId: string;
}

export type SessionTurnAttemptReason =
  | "initial"
  | "output_budget_escalation"
  | "compaction_retry"
  | "provider_fallback_retry"
  | "max_output_recovery";

export type SessionStreamChunk =
  | {
      kind: "attempt_start";
      attemptId: string;
      reason: SessionTurnAttemptReason;
    }
  | {
      kind: "attempt_superseded";
      attemptId: string;
      supersededByAttemptId: string;
      reason: Exclude<SessionTurnAttemptReason, "initial">;
    }
  | {
      kind: "assistant_text_delta";
      attemptId: string;
      delta: string;
    }
  | {
      kind: "assistant_thinking_delta";
      attemptId: string;
      delta: string;
    }
  | {
      kind: "tool_update";
      attemptId: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      verdict: ToolDisplayVerdict;
      text: string;
    };

type AssistantDeltaStreamChunk =
  | {
      kind: "assistant_text_delta";
      delta: string;
    }
  | {
      kind: "assistant_thinking_delta";
      delta: string;
    };

export interface CollectSessionPromptOutputOptions {
  onChunk?: (chunk: SessionStreamChunk) => void;
  runtime?: BrewvaRuntime;
  sessionId?: string;
}

export interface CollectSessionPromptOutputSession extends SubscribablePromptSession {}

const RECOVERY_ATTEMPT_REASONS = new Map<string, Exclude<SessionTurnAttemptReason, "initial">>([
  ["output_budget_escalation", "output_budget_escalation"],
  ["compaction_retry", "compaction_retry"],
  ["provider_fallback_retry", "provider_fallback_retry"],
  ["max_output_recovery", "max_output_recovery"],
]);

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

function asToolExecutionUpdateEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
} | null {
  if (event.type !== "tool_execution_update") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    partialResult?: unknown;
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
    partialResult: candidate.partialResult,
  };
}

function asAssistantDeltaChunk(event: AgentSessionEvent): AssistantDeltaStreamChunk | null {
  if (event.type !== "message_update") {
    return null;
  }

  const update = event as {
    assistantMessageEvent?: unknown;
  };
  if (!update.assistantMessageEvent || typeof update.assistantMessageEvent !== "object") {
    return null;
  }

  const assistantMessageEvent = update.assistantMessageEvent as {
    type?: unknown;
    delta?: unknown;
  };
  if (typeof assistantMessageEvent.delta !== "string" || assistantMessageEvent.delta.length === 0) {
    return null;
  }
  if (assistantMessageEvent.type === "text_delta") {
    return {
      kind: "assistant_text_delta",
      delta: assistantMessageEvent.delta,
    };
  }
  if (assistantMessageEvent.type === "thinking_delta") {
    return {
      kind: "assistant_thinking_delta",
      delta: assistantMessageEvent.delta,
    };
  }
  return null;
}

function emitChunk(
  options: CollectSessionPromptOutputOptions | undefined,
  chunk: SessionStreamChunk,
): void {
  if (!options?.onChunk) {
    return;
  }
  try {
    options.onChunk(chunk);
  } catch {
    // best effort callback isolation
  }
}

export async function collectSessionPromptOutput(
  session: CollectSessionPromptOutputSession,
  prompt: string,
  options?: CollectSessionPromptOutputOptions,
): Promise<SessionPromptOutput> {
  let latestAssistantText = "";
  let toolOutputs: GatewayToolOutput[] = [];
  let seenToolCallIds = new Set<string>();
  let latestToolStreamTextByCall = new Map<string, string>();
  let attemptSequence = 0;
  let currentAttemptId = "";

  const beginAttempt = (reason: SessionTurnAttemptReason): string => {
    attemptSequence += 1;
    currentAttemptId = `attempt-${attemptSequence}`;
    latestAssistantText = "";
    toolOutputs = [];
    seenToolCallIds = new Set<string>();
    latestToolStreamTextByCall = new Map<string, string>();
    emitChunk(options, {
      kind: "attempt_start",
      attemptId: currentAttemptId,
      reason,
    });
    return currentAttemptId;
  };

  const supersedeAttempt = (reason: Exclude<SessionTurnAttemptReason, "initial">): void => {
    const previousAttemptId = currentAttemptId || beginAttempt("initial");
    const nextAttemptId = `attempt-${attemptSequence + 1}`;
    emitChunk(options, {
      kind: "attempt_superseded",
      attemptId: previousAttemptId,
      supersededByAttemptId: nextAttemptId,
      reason,
    });
    beginAttempt(reason);
  };

  beginAttempt("initial");

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const assistantDelta = asAssistantDeltaChunk(event);
    if (assistantDelta) {
      emitChunk(options, {
        ...assistantDelta,
        attemptId: currentAttemptId,
      });
    }

    const toolUpdateEvent = asToolExecutionUpdateEvent(event);
    if (toolUpdateEvent) {
      const streamedText = resolveToolDisplayText({
        toolName: toolUpdateEvent.toolName,
        isError: false,
        result: toolUpdateEvent.partialResult,
      });
      const streamedVerdict = resolveToolDisplayVerdict({
        isError: false,
        result: toolUpdateEvent.partialResult,
      });
      const previousText = latestToolStreamTextByCall.get(toolUpdateEvent.toolCallId);
      if (streamedText && streamedText !== previousText) {
        latestToolStreamTextByCall.set(toolUpdateEvent.toolCallId, streamedText);
        emitChunk(options, {
          kind: "tool_update",
          attemptId: currentAttemptId,
          toolCallId: toolUpdateEvent.toolCallId,
          toolName: toolUpdateEvent.toolName,
          isError: false,
          verdict: streamedVerdict,
          text: streamedText,
        });
      }
    }

    const toolEvent = asToolExecutionEndEvent(event);
    if (toolEvent) {
      if (seenToolCallIds.has(toolEvent.toolCallId)) {
        return;
      }
      seenToolCallIds.add(toolEvent.toolCallId);
      const verdict = resolveToolDisplayVerdict({
        isError: toolEvent.isError,
        result: toolEvent.result,
      });
      toolOutputs.push({
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName,
        isError: toolEvent.isError,
        verdict,
        text: resolveToolDisplayText({
          toolName: toolEvent.toolName,
          isError: toolEvent.isError,
          result: toolEvent.result,
        }),
      });
      const finalText = toolOutputs[toolOutputs.length - 1]?.text;
      const previousText = latestToolStreamTextByCall.get(toolEvent.toolCallId);
      if (typeof finalText === "string" && finalText && finalText !== previousText) {
        latestToolStreamTextByCall.set(toolEvent.toolCallId, finalText);
        emitChunk(options, {
          kind: "tool_update",
          attemptId: currentAttemptId,
          toolCallId: toolEvent.toolCallId,
          toolName: toolEvent.toolName,
          isError: toolEvent.isError,
          verdict,
          text: finalText,
        });
      }
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

  const sessionId = options?.sessionId?.trim();
  const unsubscribeTransitions =
    options?.runtime && sessionId
      ? options.runtime.events.subscribe((event) => {
          if (
            event.sessionId !== sessionId ||
            event.type !== "session_turn_transition" ||
            !event.payload ||
            typeof event.payload !== "object"
          ) {
            return;
          }
          const payload = event.payload as {
            reason?: unknown;
            status?: unknown;
          };
          if (payload.status !== "entered") {
            return;
          }
          const reason =
            typeof payload.reason === "string"
              ? RECOVERY_ATTEMPT_REASONS.get(payload.reason)
              : undefined;
          if (!reason) {
            return;
          }
          supersedeAttempt(reason);
        })
      : undefined;

  try {
    await sendPromptWithCompactionRecovery(session, prompt, {
      runtime: options?.runtime,
      sessionId: options?.sessionId,
    });
    return {
      assistantText: latestAssistantText,
      toolOutputs,
      attemptId: currentAttemptId,
    };
  } finally {
    unsubscribe();
    unsubscribeTransitions?.();
  }
}
