import { SESSION_WIRE_SCHEMA } from "@brewva/brewva-runtime/protocol";
import type {
  AssistantTextSegmentView,
  SessionWireCommittedStatus,
  SessionWireFrame,
  SessionWireTurnTrigger,
  ToolOutputView,
} from "@brewva/brewva-runtime/protocol";

export interface RuntimeSessionWireProjectionEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload?: unknown;
  readonly turn?: unknown;
  readonly turnId?: string;
}

export function isRuntimeProjectionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeRuntimeToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  // Missing tool content is an absent transcript value, not the literal text "undefined".
  if (content === undefined || content === null) {
    return "";
  }
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content) ?? "";
    } catch {
      return "[unserializable content]";
    }
  }
  return content
    .flatMap((item) =>
      isRuntimeProjectionRecord(item) && item.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [],
    )
    .join("\n");
}

export function readRuntimeToolOutputDisplay(
  metadata: unknown,
): ToolOutputView["display"] | undefined {
  const display =
    isRuntimeProjectionRecord(metadata) && isRuntimeProjectionRecord(metadata.display)
      ? metadata.display
      : null;
  if (!display) {
    return undefined;
  }
  const output: NonNullable<ToolOutputView["display"]> = {};
  if (typeof display.summaryText === "string") {
    output.summaryText = display.summaryText;
  }
  if (typeof display.detailsText === "string") {
    output.detailsText = display.detailsText;
  }
  if (typeof display.rawText === "string") {
    output.rawText = display.rawText;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function toolOutputFromRuntimeEvent(event: {
  readonly id?: string;
  readonly type: string;
  readonly timestamp?: number;
  readonly payload?: unknown;
}): ToolOutputView | null {
  const payload = isRuntimeProjectionRecord(event.payload) ? event.payload : null;
  if (!payload) {
    return null;
  }
  if (event.type === "tool.committed") {
    const call = isRuntimeProjectionRecord(payload.call) ? payload.call : null;
    const result = isRuntimeProjectionRecord(payload.result) ? payload.result : null;
    if (!call || typeof call.toolCallId !== "string" || typeof call.toolName !== "string") {
      return null;
    }
    const ok = result?.ok !== false;
    const display = readRuntimeToolOutputDisplay(result?.metadata);
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      verdict: ok ? "pass" : "fail",
      isError: !ok,
      text: summarizeRuntimeToolContent(result?.content),
      ...(typeof event.timestamp === "number" ? { ts: event.timestamp } : {}),
      ...(typeof event.id === "string" ? { sourceEventId: event.id } : {}),
      ...(display ? { display } : {}),
    };
  }
  if (event.type === "tool.aborted") {
    const call = isRuntimeProjectionRecord(payload.call) ? payload.call : null;
    if (!call || typeof call.toolCallId !== "string" || typeof call.toolName !== "string") {
      return null;
    }
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      verdict: "fail",
      isError: true,
      text: typeof payload.reason === "string" ? payload.reason : "tool_aborted",
      ...(typeof event.timestamp === "number" ? { ts: event.timestamp } : {}),
      ...(typeof event.id === "string" ? { sourceEventId: event.id } : {}),
    };
  }
  return null;
}

export function runtimeProjectionEventTurnId(event: RuntimeSessionWireProjectionEvent): string {
  if (typeof event.turnId === "string") {
    return event.turnId.trim();
  }
  if (typeof event.turn === "string") {
    return event.turn.trim();
  }
  if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
    return String(event.turn);
  }
  return "";
}

export function runtimeAssistantTextFromEvent(
  event: RuntimeSessionWireProjectionEvent,
): string | null {
  if (event.type !== "msg.committed" || !isRuntimeProjectionRecord(event.payload)) {
    return null;
  }
  return typeof event.payload.text === "string" ? event.payload.text : null;
}

export function runtimeAssistantSegmentFromEvent(
  event: RuntimeSessionWireProjectionEvent,
): AssistantTextSegmentView | null {
  const text = runtimeAssistantTextFromEvent(event);
  if (text === null) {
    return null;
  }
  return {
    text,
    ts: event.timestamp,
    sourceEventId: event.id,
  };
}

export function runtimeTurnCommittedStatusFromPayload(
  payload: unknown,
): SessionWireCommittedStatus {
  if (!isRuntimeProjectionRecord(payload)) {
    return "completed";
  }
  return payload.status === "failed" || payload.status === "cancelled"
    ? payload.status
    : "completed";
}

export function promptTextFromRuntimeTurnStartedPayload(payload: unknown): string {
  if (!isRuntimeProjectionRecord(payload)) {
    return "";
  }
  if (typeof payload.prompt === "string") {
    return payload.prompt;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .map((part) => {
      if (!isRuntimeProjectionRecord(part)) {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "file") {
        if (typeof part.displayText === "string") return part.displayText;
        if (typeof part.name === "string") return part.name;
        if (typeof part.uri === "string") return part.uri;
      }
      return "";
    })
    .join("");
}

export function buildRuntimeTurnSessionWireFrames(input: {
  readonly sessionId: string;
  readonly events: readonly RuntimeSessionWireProjectionEvent[];
  readonly triggerFromTurnStartedPayload?: (payload: unknown) => SessionWireTurnTrigger;
}): SessionWireFrame[] {
  const frames: SessionWireFrame[] = [];
  const assistantTextByTurnId = new Map<string, string>();
  const assistantSegmentsByTurnId = new Map<string, AssistantTextSegmentView[]>();
  const toolOutputsByTurnId = new Map<string, ToolOutputView[]>();

  for (const event of input.events) {
    const turnId = runtimeProjectionEventTurnId(event);
    if (!turnId) {
      continue;
    }

    if (event.type === "turn.started") {
      frames.push({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: input.sessionId,
        frameId: `canonical:${event.id}:turn.input`,
        ts: event.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.input",
        turnId,
        promptText: promptTextFromRuntimeTurnStartedPayload(event.payload),
        trigger: input.triggerFromTurnStartedPayload?.(event.payload) ?? "recovery",
      });
      continue;
    }

    const assistantSegment = runtimeAssistantSegmentFromEvent(event);
    if (assistantSegment) {
      assistantTextByTurnId.set(
        turnId,
        `${assistantTextByTurnId.get(turnId) ?? ""}${assistantSegment.text}`,
      );
      const segments = assistantSegmentsByTurnId.get(turnId) ?? [];
      segments.push(assistantSegment);
      assistantSegmentsByTurnId.set(turnId, segments);
      continue;
    }

    const toolOutput = toolOutputFromRuntimeEvent(event);
    if (toolOutput) {
      const outputs = toolOutputsByTurnId.get(turnId) ?? [];
      outputs.push(toolOutput);
      toolOutputsByTurnId.set(turnId, outputs);
      continue;
    }

    if (event.type === "turn.ended") {
      frames.push({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: input.sessionId,
        frameId: `canonical:${event.id}:turn.committed`,
        ts: event.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.committed",
        turnId,
        attemptId: "runtime-turn",
        status: runtimeTurnCommittedStatusFromPayload(event.payload),
        assistantText: assistantTextByTurnId.get(turnId) ?? "",
        assistantSegments: assistantSegmentsByTurnId.get(turnId) ?? [],
        toolOutputs: toolOutputsByTurnId.get(turnId) ?? [],
      });
    }
  }

  return frames;
}
