import { BrewvaEffect } from "@brewva/brewva-effect";
import {
  BrewvaTurnScope,
  type BrewvaTurnEventDispatcher,
  type BrewvaTurnRuntimeError,
} from "./effect-runtime.js";
import type { BrewvaTurnLoopConfig } from "./loop.js";
import type {
  BrewvaTurnLoopContext,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopSteerDropReason,
  BrewvaTurnLoopToolResultMessage,
} from "./types.js";

export function dropPendingSteer(
  config: BrewvaTurnLoopConfig,
  dispatcher: BrewvaTurnEventDispatcher,
  reason: BrewvaTurnLoopSteerDropReason,
  signal?: AbortSignal,
): BrewvaEffect.Effect<void, BrewvaTurnRuntimeError, BrewvaTurnScope> {
  return BrewvaEffect.gen(function* () {
    const pendingSteer = yield* consumePendingSteer(config, signal);
    if (!pendingSteer) {
      return;
    }
    yield* dispatcher.emit({
      type: "steer_dropped",
      text: pendingSteer,
      reason,
    });
  });
}

export function applyPendingSteerToLastCommittedToolResult(
  currentContext: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  dispatcher: BrewvaTurnEventDispatcher,
  signal?: AbortSignal,
): BrewvaEffect.Effect<void, BrewvaTurnRuntimeError, BrewvaTurnScope> {
  return BrewvaEffect.gen(function* () {
    const target = findLastToolResultMessage(currentContext.messages);
    if (!target) {
      return;
    }
    const pendingSteer = yield* consumePendingSteer(config, signal);
    if (!pendingSteer) {
      return;
    }
    appendSteerToToolResultMessage(target, pendingSteer);
    yield* dispatcher.emit({
      type: "steer_applied",
      text: pendingSteer,
      toolCallId: target.toolCallId,
      toolName: target.toolName,
      message: target,
    });
  });
}

function consumePendingSteer(
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
): BrewvaEffect.Effect<string | undefined, BrewvaTurnRuntimeError, BrewvaTurnScope> {
  void signal;
  return config.consumePendingSteerEffect?.() ?? BrewvaEffect.succeed(undefined);
}

function findLastToolResultMessage(
  messages: BrewvaTurnLoopMessage[],
): BrewvaTurnLoopToolResultMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      return message;
    }
    if (message?.role === "user" || message?.role === "assistant") {
      return undefined;
    }
  }
  return undefined;
}

export function appendSteerToToolResultMessage(
  message: BrewvaTurnLoopToolResultMessage,
  text: string,
): void {
  message.content = [
    ...message.content,
    {
      type: "text",
      text: `\n\nUser guidance: ${text}`,
    },
  ];
}

export function toolResultMessageContainsSteer(
  message: BrewvaTurnLoopToolResultMessage,
  text: string,
): boolean {
  return message.content.some(
    (part) => part.type === "text" && part.text.includes(`User guidance: ${text}`),
  );
}
