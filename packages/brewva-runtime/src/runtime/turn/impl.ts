import { randomUUID } from "node:crypto";
import { createAsyncBridge, linkAbortSignal } from "@brewva/brewva-std/async";
import type {
  CanonicalEvent,
  KernelPort,
  ModelPort,
  PromptPlan,
  PromptContentPart,
  RuntimeProviderFrame,
  RuntimeProviderPort,
  RuntimeToolExecutorPort,
  TapeCommitPort,
  ToolCommitmentDecision,
  TurnFrame,
  TurnInput,
} from "../runtime-api.js";
import type { TapePort } from "../tape/port.js";
import { describeProviderError, isRetryableProviderError } from "./provider-error.js";

// Backstop against a provider stuck in an infinite tool-call loop — NOT a
// task-size limit. A single agentic turn legitimately makes many tool calls
// (research/refactors routinely exceed 16), so the ceiling is generous; the
// real per-turn budget is enforced by context compaction and cost guards.
// Override per runtime via BrewvaRuntimeOptions.maxProviderToolContinuationsPerTurn.
export const DEFAULT_MAX_PROVIDER_TOOL_CONTINUATIONS_PER_TURN = 200;

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
  tapeView: Pick<TapePort, "project">;
  kernel: KernelPort;
  model: ModelPort;
  provider: RuntimeProviderPort;
  toolExecutor: RuntimeToolExecutorPort;
  maxProviderToolContinuationsPerTurn?: number;
}): (turn: TurnInput) => AsyncIterable<TurnFrame> {
  const maxProviderToolContinuations =
    input.maxProviderToolContinuationsPerTurn ?? DEFAULT_MAX_PROVIDER_TOOL_CONTINUATIONS_PER_TURN;
  return async function* runTurn(turn: TurnInput): AsyncIterable<TurnFrame> {
    const provider = input.provider;
    type ToolOutcome = "continue" | "committed" | "suspend";
    type AllowedToolDecision = Extract<ToolCommitmentDecision, { readonly kind: "allow" }>;
    type ToolExecutionQueueItem =
      | { readonly kind: "progress"; readonly frame: TurnFrame }
      | {
          readonly kind: "done";
          readonly result: Awaited<ReturnType<RuntimeToolExecutorPort["execute"]>>;
        };
    if (turn.resume) {
      const resumeTurnId = turn.resume.turnId.trim();
      if (!resumeTurnId) {
        throw new Error("compaction_resume_requires_turn_id");
      }
      if (turn.turnId && turn.turnId !== resumeTurnId) {
        throw new Error("compaction_resume_turn_id_mismatch");
      }
      const turnState = input.tapeView.project(turn.sessionId, "turn_state");
      if (turnState.lastCause !== "compaction_required") {
        throw new Error("compaction_resume_requires_suspended_compaction_turn");
      }
    }
    let turnId = turn.resume?.turnId ?? turn.turnId ?? `turn_${randomUUID()}`;

    function suspendForInterrupt(): TurnFrame {
      const suspended = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "runtime.suspended",
        payload: { cause: "interrupt" },
      });
      return { type: "runtime.event", event: suspended };
    }

    async function* executeAllowedToolDecision(
      decision: AllowedToolDecision,
    ): AsyncGenerator<TurnFrame, ToolOutcome, void> {
      const controller = new AbortController();
      const unlinkAbort = linkAbortSignal(turn.signal, controller);
      const bridge = createAsyncBridge<ToolExecutionQueueItem>({
        onCancel() {
          controller.abort();
        },
      });
      const producer = input.toolExecutor
        .execute(decision.commitment, {
          signal: controller.signal,
          async onProgress(update) {
            await bridge.write({
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
        })
        .then((result) => {
          return bridge.write({ kind: "done", result });
        })
        .then(() => {
          bridge.close();
        })
        .catch((error) => bridge.fail(error));
      try {
        for await (const next of bridge) {
          if (next.kind === "progress") {
            yield next.frame;
            continue;
          }
          const committed = await input.kernel.commitToolResult({
            commitmentId: decision.commitment.id,
            result: next.result,
          });
          yield { type: "runtime.event", event: committed.event };
          return "committed";
        }
      } catch (error) {
        const aborted = await input.kernel.abortToolCall({
          commitmentId: decision.commitment.id,
          reason: error instanceof Error ? error.message : "tool_execution_failed",
        });
        yield { type: "runtime.event", event: aborted.event };
      } finally {
        bridge.close();
        unlinkAbort();
        void producer.catch(() => undefined);
      }
      return "continue";
    }

    async function* handleToolDecision(
      decision: ToolCommitmentDecision,
    ): AsyncGenerator<TurnFrame, ToolOutcome, void> {
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
      return yield* executeAllowedToolDecision(decision);
    }

    async function* handleProviderToolFrame(
      frame: Extract<RuntimeProviderFrame, { type: "tool" }>,
    ): AsyncGenerator<TurnFrame, ToolOutcome, void> {
      const decision = await input.kernel.beginToolCall({
        sessionId: turn.sessionId,
        turnId,
        ...frame.call,
      });
      return yield* handleToolDecision(decision);
    }

    async function materializeReadyPrompt(): Promise<{
      readonly prompt: PromptPlan;
      readonly events: readonly CanonicalEvent[];
    }> {
      const events: CanonicalEvent[] = [];
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
        events.push(checkpoint);
        prompt = await input.model.materialize({
          sessionId: turn.sessionId,
          budget: turn.budget,
        });
        if (prompt.status === "over_window") {
          throw new Error("context_window_exceeded_after_checkpoint");
        }
      }
      return { prompt, events };
    }

    function* commitBufferedAssistantOutput(buffer: {
      assistantText: string;
      reasonText: string;
    }): Generator<TurnFrame, void, void> {
      if (buffer.reasonText.length > 0) {
        const reason = input.tape.commit({
          sessionId: turn.sessionId,
          turnId,
          type: "reason.committed",
          payload: { text: buffer.reasonText },
        });
        buffer.reasonText = "";
        yield { type: "runtime.event", event: reason };
      }

      if (buffer.assistantText.length > 0) {
        const message = input.tape.commit({
          sessionId: turn.sessionId,
          turnId,
          type: "msg.committed",
          payload: { text: buffer.assistantText },
        });
        buffer.assistantText = "";
        yield { type: "runtime.event", event: message };
      }
    }

    let terminalCommitted = false;

    function failureMessage(error: unknown): string {
      // Record the whole cause chain, not just the top-level message, so an
      // opaque provider "Connection error." carries its underlying reason.
      return describeProviderError(error);
    }

    function decisionIncludesAbortedToolResult(decision: ToolCommitmentDecision): boolean {
      return decision.events.some((event) => event.type === "tool.aborted");
    }

    function commitTurnEnded(
      inputValue: {
        status?: "completed" | "failed" | "cancelled";
        error?: string;
      } = {},
    ): TurnFrame {
      const status = inputValue.status ?? "completed";
      const ended = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "turn.ended",
        payload: {
          cause: "terminal_commit",
          ...(status === "completed" ? {} : { status }),
          ...(inputValue.error ? { error: inputValue.error } : {}),
        },
      });
      terminalCommitted = true;
      return { type: "runtime.event", event: ended };
    }

    const approvalDecision = turn.resolveApproval
      ? await input.kernel.resolveApprovalDecision({
          sessionId: turn.sessionId,
          requestId: turn.resolveApproval.requestId,
        })
      : null;
    const approvalTurnId =
      approvalDecision?.kind === "allow"
        ? approvalDecision.commitment.call.turnId
        : approvalDecision?.kind === "defer"
          ? approvalDecision.request.turnId
          : undefined;
    if (!turn.turnId && approvalTurnId) {
      turnId = approvalTurnId;
    }

    if (!turn.resolveApproval && !turn.resume) {
      const started = input.tape.commit({
        sessionId: turn.sessionId,
        turnId,
        type: "turn.started",
        payload: turnStartedPayload(turn),
      });
      yield { type: "runtime.event", event: started };
    }

    if (turn.signal?.aborted) {
      yield suspendForInterrupt();
      yield { type: "runtime.suspended", cause: "interrupt" };
      return;
    }

    try {
      let retryProviderOnce = true;
      let committedToolThisTurn = false;
      let providerToolContinuations = 0;
      if (approvalDecision) {
        const approvalOutcome = yield* handleToolDecision(approvalDecision);
        if (approvalOutcome === "suspend") {
          return;
        }
        // An approved (allow) tool that aborts at execution time emits a
        // tool.aborted result the model can observe, exactly like an inline
        // provider-tool abort. Treat it as a valid continue so the model reacts,
        // instead of killing the turn with approval_resolution_did_not_commit_tool.
        const approvedToolAborted =
          approvalDecision.kind === "allow" && approvalOutcome === "continue";
        if (
          approvalOutcome === "committed" ||
          decisionIncludesAbortedToolResult(approvalDecision) ||
          approvedToolAborted
        ) {
          committedToolThisTurn = true;
          providerToolContinuations = 1;
        } else {
          throw new Error(
            approvalDecision.kind === "block"
              ? `approval_resolution_blocked:${approvalDecision.reason}`
              : "approval_resolution_did_not_commit_tool",
          );
        }
      }
      for (;;) {
        const materialized = await materializeReadyPrompt();
        for (const event of materialized.events) {
          yield { type: "runtime.event", event };
        }

        if (turn.signal?.aborted) {
          yield suspendForInterrupt();
          yield { type: "runtime.suspended", cause: "interrupt" };
          return;
        }

        const passOutput = { assistantText: "", reasonText: "" };
        let passHadTool = false;
        let localFrameError: unknown = null;
        let currentAttemptProducedFrame = false;
        try {
          for await (const frame of provider.stream({ turn, prompt: materialized.prompt })) {
            currentAttemptProducedFrame = true;
            if (turn.signal?.aborted) {
              yield suspendForInterrupt();
              yield { type: "runtime.suspended", cause: "interrupt" };
              return;
            }
            if (frame.type === "text") {
              passOutput.assistantText += frame.delta;
              yield frame;
              continue;
            }
            if (frame.type === "reason") {
              passOutput.reasonText += frame.delta;
              yield { type: "reason", delta: frame.delta };
              continue;
            }
            yield* commitBufferedAssistantOutput(passOutput);
            if (providerToolContinuations >= maxProviderToolContinuations) {
              throw new Error("provider_tool_continuation_limit_exceeded");
            }
            passHadTool = true;
            let toolOutcome: "continue" | "committed" | "suspend";
            try {
              toolOutcome = yield* handleProviderToolFrame(frame);
            } catch (error) {
              localFrameError = error;
              throw error;
            }
            if (toolOutcome === "suspend") {
              return;
            }
            if (toolOutcome === "committed") {
              committedToolThisTurn = true;
            }
          }
          yield* commitBufferedAssistantOutput(passOutput);
          if (passHadTool) {
            if (committedToolThisTurn && turn.softCut?.afterToolResult() === true) {
              const suspended = input.tape.commit({
                sessionId: turn.sessionId,
                turnId,
                type: "runtime.suspended",
                payload: { cause: "compaction_required" },
              });
              yield { type: "runtime.event", event: suspended };
              yield { type: "runtime.suspended", cause: "compaction_required" };
              return;
            }
            providerToolContinuations += 1;
            continue;
          }
          break;
        } catch (error) {
          if (error === localFrameError) {
            throw error;
          }
          if (
            !retryProviderOnce ||
            currentAttemptProducedFrame ||
            committedToolThisTurn ||
            passOutput.assistantText.length > 0 ||
            passOutput.reasonText.length > 0 ||
            !isRetryableProviderError(error)
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
              error: describeProviderError(error, "provider_stream_failed"),
            },
          });
          yield { type: "runtime.event", event: retry };
        }
      }

      yield commitTurnEnded();
    } catch (error) {
      if (!terminalCommitted) {
        yield commitTurnEnded({ status: "failed", error: failureMessage(error) });
      }
      throw error;
    }
  };
}
