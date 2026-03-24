import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSession, PromptOptions } from "@mariozechner/pi-coding-agent";

const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";

type PromptDispatchOptions = PromptOptions;
type LegacyUserMessageContent = Parameters<AgentSession["sendUserMessage"]>[0];
type LegacyUserMessageOptions = Parameters<AgentSession["sendUserMessage"]>[1];
type LegacyUserMessageDeliverAs = NonNullable<LegacyUserMessageOptions>["deliverAs"];
type LegacyUserMessagePart = Exclude<LegacyUserMessageContent, string>[number];

interface PromptCapableCompactionRecoverySessionLike {
  prompt: AgentSession["prompt"];
  followUp: AgentSession["followUp"];
  agent: {
    waitForIdle: () => Promise<void>;
  };
  sessionManager?: {
    getSessionId?: () => string;
  };
}

interface UserMessageCapableCompactionRecoverySessionLike {
  sendUserMessage: AgentSession["sendUserMessage"];
  agent: {
    waitForIdle: () => Promise<void>;
  };
  sessionManager?: {
    getSessionId?: () => string;
  };
}

export type CompactionRecoverySessionLike =
  | PromptCapableCompactionRecoverySessionLike
  | UserMessageCapableCompactionRecoverySessionLike;

export interface CompactionRecoveryOptions {
  runtime?: BrewvaRuntime;
  sessionId?: string;
  turnId?: string;
  promptOptions?: PromptDispatchOptions;
}

function normalizeSessionId(input: CompactionRecoverySessionLike): string | undefined {
  const value = input.sessionManager?.getSessionId?.();
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasPromptDispatch(
  input: CompactionRecoverySessionLike,
): input is PromptCapableCompactionRecoverySessionLike {
  return typeof (input as PromptCapableCompactionRecoverySessionLike).prompt === "function";
}

function hasLegacyUserMessageDispatch(
  input: CompactionRecoverySessionLike,
): input is UserMessageCapableCompactionRecoverySessionLike {
  return (
    typeof (input as UserMessageCapableCompactionRecoverySessionLike).sendUserMessage === "function"
  );
}

function isLegacyUserMessagePart(value: unknown): value is LegacyUserMessagePart {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as { type?: unknown }).type === "string";
}

function assertLegacyPromptOptionsSupported(promptOptions?: PromptDispatchOptions): void {
  if (!promptOptions) {
    return;
  }
  if (promptOptions.expandPromptTemplates === true) {
    throw new Error("legacy sendUserMessage fallback does not support expandPromptTemplates=true");
  }
  if (typeof promptOptions.source === "string" && promptOptions.source !== "extension") {
    throw new Error("legacy sendUserMessage fallback only supports source='extension'");
  }
}

function buildLegacyUserMessageContent(
  content: string,
  promptOptions?: PromptDispatchOptions,
): LegacyUserMessageContent {
  const imageParts = promptOptions?.images ?? [];
  if (imageParts.length === 0) {
    return content;
  }

  const normalizedParts = imageParts.filter(isLegacyUserMessagePart);
  if (normalizedParts.length !== imageParts.length) {
    throw new Error("legacy sendUserMessage fallback requires image parts with a string type");
  }

  return [{ type: "text", text: content }, ...normalizedParts];
}

function toLegacyDeliverAs(
  behavior: PromptDispatchOptions["streamingBehavior"] | undefined,
): LegacyUserMessageDeliverAs {
  return behavior === "steer" || behavior === "followUp" ? behavior : undefined;
}

async function dispatchPrompt(
  session: CompactionRecoverySessionLike,
  prompt: string,
  promptOptions?: PromptDispatchOptions,
): Promise<void> {
  if (hasPromptDispatch(session)) {
    await session.prompt(prompt, promptOptions);
    return;
  }
  if (hasLegacyUserMessageDispatch(session)) {
    assertLegacyPromptOptionsSupported(promptOptions);
    await session.sendUserMessage(buildLegacyUserMessageContent(prompt, promptOptions), {
      deliverAs: toLegacyDeliverAs(promptOptions?.streamingBehavior),
    });
    return;
  }
  throw new Error("session does not support prompt dispatch");
}

async function dispatchFollowUp(
  session: CompactionRecoverySessionLike,
  content: string,
): Promise<void> {
  if (hasPromptDispatch(session)) {
    await session.followUp(content);
    return;
  }
  if (hasLegacyUserMessageDispatch(session)) {
    await session.sendUserMessage(content, { deliverAs: "followUp" });
    return;
  }
  throw new Error("session does not support follow-up dispatch");
}

function buildResumeEventPayload(input: {
  turnId?: string;
  sourceEventId: string;
  sourceTimestamp: number;
  error?: string;
}): Record<string, unknown> {
  return {
    turnId: input.turnId ?? null,
    sourceEventId: input.sourceEventId,
    sourceTimestamp: input.sourceTimestamp,
    error: input.error ?? null,
  };
}

export async function sendPromptWithCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const runtime = options.runtime;
  const sessionId = options.sessionId?.trim() || normalizeSessionId(session);
  const turnId = options.turnId?.trim();
  const recoveryStartAt = Date.now();

  let queuedResumeGeneration = 0;
  let observedResumeGeneration = 0;
  let resumeDispatchPromise: Promise<void> = Promise.resolve();
  const seenCompactionEventIds = new Set<string>();

  const unsubscribe =
    runtime && sessionId
      ? runtime.events.subscribe((event) => {
          if (event.sessionId !== sessionId) return;
          if (event.type !== "session_compact") return;
          if (event.timestamp < recoveryStartAt) return;
          if (seenCompactionEventIds.has(event.id)) return;

          seenCompactionEventIds.add(event.id);
          queuedResumeGeneration += 1;
          runtime.events.record({
            sessionId,
            type: "session_turn_compaction_resume_requested",
            payload: buildResumeEventPayload({
              turnId,
              sourceEventId: event.id,
              sourceTimestamp: event.timestamp,
            }),
          });

          resumeDispatchPromise = resumeDispatchPromise.then(async () => {
            try {
              await dispatchFollowUp(session, COMPACTION_RESUME_PROMPT);
              runtime.events.record({
                sessionId,
                type: "session_turn_compaction_resume_dispatched",
                payload: buildResumeEventPayload({
                  turnId,
                  sourceEventId: event.id,
                  sourceTimestamp: event.timestamp,
                }),
              });
            } catch (error) {
              runtime.events.record({
                sessionId,
                type: "session_turn_compaction_resume_failed",
                payload: buildResumeEventPayload({
                  turnId,
                  sourceEventId: event.id,
                  sourceTimestamp: event.timestamp,
                  error: error instanceof Error ? error.message : String(error),
                }),
              });
              throw error;
            }
          });
        })
      : undefined;

  try {
    await dispatchPrompt(session, prompt, options.promptOptions);

    while (true) {
      await session.agent.waitForIdle();
      await Promise.resolve();

      if (queuedResumeGeneration === observedResumeGeneration) {
        break;
      }

      observedResumeGeneration = queuedResumeGeneration;
      await resumeDispatchPromise;
    }
  } finally {
    unsubscribe?.();
  }
}

export function wrapSessionWithCompactionRecovery<
  T extends PromptCapableCompactionRecoverySessionLike,
>(
  session: T,
  options: {
    runtime?: BrewvaRuntime;
    turnId?: string | (() => string | undefined);
  } = {},
): T {
  const originalPrompt = session.prompt.bind(session);
  const originalFollowUp = session.followUp.bind(session);

  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "prompt") {
        return (content: string, promptOptions?: PromptDispatchOptions) =>
          sendPromptWithCompactionRecovery(
            {
              prompt: originalPrompt,
              followUp: originalFollowUp,
              agent: target.agent,
              sessionManager: target.sessionManager,
            },
            content,
            {
              runtime: options.runtime,
              sessionId: target.sessionManager?.getSessionId?.(),
              turnId: typeof options.turnId === "function" ? options.turnId() : options.turnId,
              promptOptions,
            },
          );
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
};
