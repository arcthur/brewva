import type { BrewvaRuntime } from "@brewva/brewva-runtime";

const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";

type SendUserMessageOptions = {
  deliverAs?: "followUp";
};

export interface CompactionRecoverySessionLike {
  sendUserMessage: (content: string, options?: SendUserMessageOptions) => Promise<void>;
  agent: {
    waitForIdle: () => Promise<void>;
  };
}

export interface CompactionRecoveryOptions {
  runtime?: BrewvaRuntime;
  sessionId?: string;
  turnId?: string;
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
  const sessionId = options.sessionId?.trim();
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
              await session.sendUserMessage(COMPACTION_RESUME_PROMPT, {
                deliverAs: "followUp",
              });
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
    await session.sendUserMessage(prompt);

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

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
};
