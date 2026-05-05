import type { BrewvaTurnLoopConfig, BrewvaTurnLoopEventSink } from "./loop.js";
import type {
  BrewvaTurnLoopContext,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopSteerDropReason,
  BrewvaTurnLoopToolResultMessage,
} from "./types.js";

export async function dropPendingSteer(
  config: BrewvaTurnLoopConfig,
  emit: BrewvaTurnLoopEventSink,
  reason: BrewvaTurnLoopSteerDropReason,
): Promise<void> {
  const pendingSteer = await config.consumePendingSteer?.();
  if (!pendingSteer) {
    return;
  }
  await emit({
    type: "steer_dropped",
    text: pendingSteer,
    reason,
  });
}

export async function applyPendingSteerToLastCommittedToolResult(
  currentContext: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  emit: BrewvaTurnLoopEventSink,
): Promise<void> {
  const target = findLastToolResultMessage(currentContext.messages);
  if (!target) {
    return;
  }
  const pendingSteer = await config.consumePendingSteer?.();
  if (!pendingSteer) {
    return;
  }
  appendSteerToToolResultMessage(target, pendingSteer);
  await emit({
    type: "steer_applied",
    text: pendingSteer,
    toolCallId: target.toolCallId,
    toolName: target.toolName,
    message: target,
  });
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
