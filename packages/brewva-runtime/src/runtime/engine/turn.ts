import { randomUUID } from "node:crypto";
import type {
  KernelPort,
  ModelPort,
  PromptContentPart,
  RuntimeProviderFrame,
  RuntimeProviderPort,
  RuntimeToolExecutorPort,
  TapeCommitPort,
  TurnFrame,
  TurnInput,
} from "../runtime-api.js";

const EMPTY_PROVIDER: RuntimeProviderPort = Object.freeze({
  async *stream() {},
});

function clonePromptContentPart(part: PromptContentPart): PromptContentPart {
  return Object.freeze({ ...part });
}

function cloneTurnPromptContent(prompt: TurnInput["prompt"]): readonly PromptContentPart[] {
  if (typeof prompt === "string") {
    return [Object.freeze({ type: "text" as const, text: prompt })];
  }
  return prompt.map((part) => clonePromptContentPart(part));
}

function promptTextFromContent(content: readonly PromptContentPart[]): string {
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "file") {
        return part.displayText ?? part.name ?? part.uri;
      }
      return "";
    })
    .join("");
}

function turnStartedPayload(turn: TurnInput): {
  readonly prompt: string;
  readonly content: readonly PromptContentPart[];
  readonly mode?: string;
} {
  const content = cloneTurnPromptContent(turn.prompt);
  return Object.freeze({
    prompt: promptTextFromContent(content),
    content,
    ...(turn.mode ? { mode: turn.mode } : {}),
  });
}

export function createTurnRunner(input: {
  tape: TapeCommitPort;
  kernel: KernelPort;
  model: ModelPort;
  provider?: RuntimeProviderPort;
  toolExecutor?: RuntimeToolExecutorPort;
}): (turn: TurnInput) => AsyncIterable<TurnFrame> {
  return async function* runTurn(turn: TurnInput): AsyncIterable<TurnFrame> {
    const provider = input.provider ?? EMPTY_PROVIDER;
    const turnId = turn.turnId ?? `turn_${randomUUID()}`;

    function suspendForInterrupt(): TurnFrame {
      const suspended = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "runtime.suspended",
        payload: { cause: "interrupt" },
      });
      return { type: "runtime.event", event: suspended };
    }

    async function* handleProviderToolFrame(
      frame: Extract<RuntimeProviderFrame, { type: "tool" }>,
    ): AsyncGenerator<TurnFrame, "continue" | "suspend", void> {
      const decision = await input.kernel.beginToolCall({
        sessionId: turn.sessionId,
        turnId,
        ...frame.call,
      });
      for (const event of decision.events) {
        yield { type: "runtime.event", event };
      }
      if (decision.kind === "block") {
        return "continue";
      }
      if (decision.kind === "defer") {
        const suspended = input.tape.commit({
          sessionId: turn.sessionId,
          turnId,
          type: "runtime.suspended",
          payload: {
            cause: "approval_pending",
            commitmentId: decision.commitmentId,
            approvalRequestId: decision.request.id,
          },
        });
        yield { type: "runtime.event", event: suspended };
        yield { type: "runtime.suspended", cause: "approval_pending" };
        return "suspend";
      }
      if (!input.toolExecutor) {
        const aborted = await input.kernel.abortToolCall({
          commitmentId: decision.commitment.id,
          reason: "missing_tool_executor",
        });
        yield { type: "runtime.event", event: aborted.event };
        return "continue";
      }
      type ToolExecutionQueueItem =
        | { readonly kind: "progress"; readonly frame: TurnFrame }
        | {
            readonly kind: "done";
            readonly result: Awaited<ReturnType<RuntimeToolExecutorPort["execute"]>>;
          }
        | { readonly kind: "error"; readonly error: unknown };
      const queue: ToolExecutionQueueItem[] = [];
      let resume: ((item: ToolExecutionQueueItem) => void) | null = null;
      const push = (item: ToolExecutionQueueItem): void => {
        if (resume) {
          const resolve = resume;
          resume = null;
          resolve(item);
          return;
        }
        queue.push(item);
      };
      Promise.resolve()
        .then(() =>
          input.toolExecutor?.execute(decision.commitment, {
            signal: turn.signal,
            onProgress(update) {
              push({
                kind: "progress",
                frame: {
                  type: "tool.progress",
                  progress: {
                    toolCallId: decision.commitment.call.toolCallId,
                    toolName: decision.commitment.call.toolName,
                    update,
                  },
                },
              });
            },
          }),
        )
        .then((result) => {
          if (!result) {
            throw new Error("missing_tool_executor");
          }
          push({ kind: "done", result });
        })
        .catch((error) => push({ kind: "error", error }));
      try {
        for (;;) {
          const next =
            queue.shift() ??
            (await new Promise<ToolExecutionQueueItem>((resolve) => {
              resume = resolve;
            }));
          if (next.kind === "progress") {
            yield next.frame;
            continue;
          }
          if (next.kind === "error") {
            throw next.error;
          }
          const committed = await input.kernel.commitToolResult({
            commitmentId: decision.commitment.id,
            result: next.result,
          });
          yield { type: "runtime.event", event: committed.event };
          break;
        }
      } catch (error) {
        const aborted = await input.kernel.abortToolCall({
          commitmentId: decision.commitment.id,
          reason: error instanceof Error ? error.message : "tool_execution_failed",
        });
        yield { type: "runtime.event", event: aborted.event };
      }
      return "continue";
    }

    const started = input.tape.commit({
      sessionId: turn.sessionId,
      turnId,
      type: "turn.started",
      payload: turnStartedPayload(turn),
    });
    yield { type: "runtime.event", event: started };

    if (turn.signal?.aborted) {
      yield suspendForInterrupt();
      yield { type: "runtime.suspended", cause: "interrupt" };
      return;
    }

    let prompt = await input.model.materialize({
      sessionId: turn.sessionId,
      budget: turn.budget,
    });
    if (prompt.status === "over_window") {
      const candidate = await input.model.proposeCheckpoint({
        sessionId: turn.sessionId,
        budget: turn.budget,
        reason: "compaction_required",
      });
      const checkpoint = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "checkpoint.committed",
        payload: { ...candidate, cause: "compaction_required" },
      });
      yield { type: "runtime.event", event: checkpoint };
      prompt = await input.model.materialize({
        sessionId: turn.sessionId,
        budget: turn.budget,
      });
      if (prompt.status === "over_window") {
        throw new Error("context_window_exceeded_after_checkpoint");
      }
    }

    if (turn.signal?.aborted) {
      yield suspendForInterrupt();
      yield { type: "runtime.suspended", cause: "interrupt" };
      return;
    }

    let assistantText = "";
    let reasonText = "";
    let retryProviderOnce = true;
    for (;;) {
      let localFrameError: unknown = null;
      let currentAttemptProducedFrame = false;
      try {
        for await (const frame of provider.stream({ turn, prompt })) {
          currentAttemptProducedFrame = true;
          if (turn.signal?.aborted) {
            yield suspendForInterrupt();
            yield { type: "runtime.suspended", cause: "interrupt" };
            return;
          }
          if (frame.type === "text") {
            assistantText += frame.delta;
            yield frame;
            continue;
          }
          if (frame.type === "reason") {
            reasonText += frame.delta;
            yield { type: "reason", delta: frame.delta };
            continue;
          }
          let toolOutcome: "continue" | "suspend";
          try {
            toolOutcome = yield* handleProviderToolFrame(frame);
          } catch (error) {
            localFrameError = error;
            throw error;
          }
          if (toolOutcome === "suspend") {
            return;
          }
        }
        break;
      } catch (error) {
        if (error === localFrameError) {
          throw error;
        }
        if (
          !retryProviderOnce ||
          currentAttemptProducedFrame ||
          assistantText.length > 0 ||
          reasonText.length > 0
        ) {
          throw error;
        }
        retryProviderOnce = false;
        const retry = input.tape.commit({
          sessionId: turn.sessionId,
          turnId,
          type: "runtime.suspended",
          payload: {
            cause: "provider_retry",
            error: error instanceof Error ? error.message : "provider_stream_failed",
          },
        });
        yield { type: "runtime.event", event: retry };
      }
    }

    if (reasonText.length > 0) {
      const reason = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "reason.committed",
        payload: { text: reasonText },
      });
      yield { type: "runtime.event", event: reason };
    }

    if (assistantText.length > 0) {
      const message = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "msg.committed",
        payload: { text: assistantText },
      });
      yield { type: "runtime.event", event: message };
    }

    const ended = input.tape.commit({
      sessionId: turn.sessionId,
      turnId,
      type: "turn.ended",
      payload: { cause: "terminal_commit" },
    });
    yield { type: "runtime.event", event: ended };
  };
}
