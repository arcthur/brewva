import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import { toJsonValue } from "@brewva/brewva-std/json";
import { SESSION_WIRE_SCHEMA } from "@brewva/brewva-vocabulary/wire";
import type { SessionWireFrame, ToolOutputView } from "@brewva/brewva-vocabulary/wire";

export type RuntimeWireOpenToolCall = {
  readonly toolCallId: ReturnType<typeof asBrewvaToolCallId>;
  readonly toolName: ReturnType<typeof asBrewvaToolName>;
};

export class RuntimeWireToolLifecycleTracker {
  readonly #open = new Map<string, RuntimeWireOpenToolCall>();

  noteOpen(input: { readonly toolCallId: string; readonly toolName: string }): void {
    if (this.#open.has(input.toolCallId)) {
      return;
    }
    this.#open.set(input.toolCallId, {
      toolCallId: asBrewvaToolCallId(input.toolCallId),
      toolName: asBrewvaToolName(input.toolName),
    });
  }

  noteFinished(toolCallId: string): void {
    this.#open.delete(toolCallId);
  }

  openCalls(): readonly RuntimeWireOpenToolCall[] {
    return [...this.#open.values()];
  }
}

const TURN_FAILED_BEFORE_TOOL_RECEIPT =
  "Effectful tool failed before a committed receipt." as const;

function runtimeWireToolLifecycleFallbackDetails(
  lifecycleFallbackReason: string,
): ToolOutputView["details"] {
  return toJsonValue({ lifecycleFallbackReason });
}

function emitRuntimeBranchFrame(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly build: (
    frameId: string,
    sessionId: ReturnType<typeof asBrewvaSessionId>,
  ) => SessionWireFrame;
  readonly nextSequence: () => number;
}): void {
  const turnId = input.turnId?.trim();
  if (!turnId || !input.onFrame) {
    return;
  }
  const sessionId = asBrewvaSessionId(input.sessionId);
  const frameId = `live:${input.sessionId}:${turnId}:runtime:${input.nextSequence()}`;
  input.onFrame(input.build(frameId, sessionId));
}

export function emitRuntimeToolFinishedFrame(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly toolCallId: ReturnType<typeof asBrewvaToolCallId>;
  readonly toolName: ReturnType<typeof asBrewvaToolName>;
  readonly verdict: ToolOutputView["verdict"];
  readonly isError: boolean;
  readonly text: string;
  readonly details?: ToolOutputView["details"];
  readonly display?: ToolOutputView["display"];
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
}): void {
  emitRuntimeBranchFrame({
    sessionId: input.sessionId,
    turnId: input.turnId,
    onFrame: input.onFrame,
    nextSequence: input.nextSequence,
    build: (frameId, wireSessionId) => ({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: wireSessionId,
      frameId,
      ts: Date.now(),
      source: "live",
      durability: "cache",
      type: "tool.finished",
      turnId: input.turnId ?? "",
      attemptId: input.attemptId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      verdict: input.verdict,
      isError: input.isError,
      text: input.text,
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.display ? { display: input.display } : {}),
    }),
  });
}

export function closeOpenRuntimeWireTools(input: {
  readonly tracker: RuntimeWireToolLifecycleTracker;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
  readonly lifecycleFallbackReason: string;
  readonly toolOutputs?: ToolOutputView[];
  readonly sequence?: number;
}): void {
  for (const open of input.tracker.openCalls()) {
    const toolOutput: ToolOutputView = {
      toolCallId: open.toolCallId,
      toolName: open.toolName,
      verdict: "fail",
      isError: true,
      text: TURN_FAILED_BEFORE_TOOL_RECEIPT,
      details: runtimeWireToolLifecycleFallbackDetails(input.lifecycleFallbackReason),
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    };
    input.toolOutputs?.push(toolOutput);
    emitRuntimeToolFinishedFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      toolCallId: open.toolCallId,
      toolName: open.toolName,
      verdict: toolOutput.verdict,
      isError: toolOutput.isError,
      text: toolOutput.text,
      details: toolOutput.details,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
    });
    input.tracker.noteFinished(open.toolCallId);
  }
}
