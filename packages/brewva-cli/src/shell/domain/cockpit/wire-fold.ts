import type {
  AssistantTextSegmentView,
  SessionWireFrame,
  ToolOutputView,
} from "@brewva/brewva-vocabulary/wire";
import {
  buildTextTranscriptMessage,
  upsertToolExecutionIntoTranscriptMessages,
  type CliShellTranscriptMessage,
} from "../transcript.js";
import { appendThinkingPreview, compactPromptPreview } from "./preview.js";
import type {
  ShellCockpitFoldedAnswer,
  ShellCockpitFoldedSourceRef,
  ShellCockpitFoldedToolCall,
  ShellCockpitRuntimeActivity,
  ShellCockpitWireFoldSnapshot,
} from "./types.js";

type MutableRuntimeActivity = {
  status: ShellCockpitRuntimeActivity["status"];
  turnId: string;
  attemptId: string | null;
  startedAt: number;
  lastProgressAt: number;
  lastProgressRef: string;
  promptPreview: string | null;
  thinkingPreview: string;
  latestThinkingRef?: string;
  progressLabel: string;
  streamedChars: number;
  providerBuffered: boolean;
  committed: boolean;
};

type MutableAnswer = ShellCockpitFoldedAnswer & {
  committed: boolean;
};

type MutableToolCall = ShellCockpitFoldedToolCall;

type MutableTranscriptAssistantSegment = {
  readonly turnId: string;
  readonly attemptId: string;
  readonly messageId: string;
  text: string;
};

type RuntimeToolSessionWireFrame = Extract<
  SessionWireFrame,
  { type: "tool.progress" | "tool.finished" }
>;

type CommittedTranscriptReplayItem =
  | {
      readonly kind: "assistant";
      readonly ts: number;
      readonly sequence?: number;
      readonly order: number;
      readonly segment: AssistantTextSegmentView;
      readonly messageId: string;
    }
  | {
      readonly kind: "tool";
      readonly ts: number;
      readonly sequence?: number;
      readonly order: number;
      readonly toolOutput: ToolOutputView;
    };

function frameRef(frame: SessionWireFrame): string {
  return frame.sourceEventId ?? frame.frameId;
}

function frameKey(frame: SessionWireFrame): string {
  return frame.sourceEventId
    ? `${frame.sourceEventId}:${frame.type}`
    : `${frame.sessionId}:${frame.frameId}`;
}

function compareFrames(left: SessionWireFrame, right: SessionWireFrame): number {
  return left.ts - right.ts || left.frameId.localeCompare(right.frameId);
}

function turnIdOf(frame: SessionWireFrame): string | undefined {
  return "turnId" in frame && typeof frame.turnId === "string" ? frame.turnId : undefined;
}

function transcriptMessagePrefix(sessionId: string): string {
  return `wire:${sessionId}:`;
}

function transcriptAssistantMessageId(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly sequence: number;
}): string {
  return `${transcriptMessagePrefix(input.sessionId)}${input.turnId}:${input.attemptId}:assistant:${input.sequence}`;
}

function transcriptCommittedAssistantMessageId(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
}): string {
  return `${transcriptMessagePrefix(input.sessionId)}${input.turnId}:${input.attemptId}:assistant:committed`;
}

function transcriptCommittedAssistantSegmentMessageId(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly segment: AssistantTextSegmentView;
  readonly index: number;
}): string {
  const segmentOrdinal =
    typeof input.segment.sequence === "number" && Number.isFinite(input.segment.sequence)
      ? `sequence:${input.segment.sequence}`
      : `index:${input.index}`;
  const segmentRef =
    input.segment.sourceEventId !== undefined
      ? `${input.segment.sourceEventId}:${segmentOrdinal}`
      : segmentOrdinal;
  return `${transcriptMessagePrefix(input.sessionId)}${input.turnId}:${
    input.attemptId
  }:assistant:committed:${segmentRef}`;
}

function transcriptToolMessageId(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}): string {
  return `${transcriptMessagePrefix(input.sessionId)}${input.turnId}:tool:${input.toolCallId}`;
}

function readReplayItemSequence(input: { readonly sequence?: number }): number | undefined {
  return typeof input.sequence === "number" && Number.isFinite(input.sequence)
    ? input.sequence
    : undefined;
}

function buildRuntimeToolResultPayload(frame: RuntimeToolSessionWireFrame): {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: { readonly verdict: string };
  readonly display?: RuntimeToolSessionWireFrame["display"];
  readonly isError: boolean;
} {
  return {
    content: frame.text.length > 0 ? [{ type: "text", text: frame.text }] : [],
    details: { verdict: frame.verdict },
    ...(frame.display ? { display: frame.display } : {}),
    isError: frame.isError,
  };
}

function sortCommittedTranscriptReplayItems(
  items: readonly CommittedTranscriptReplayItem[],
): CommittedTranscriptReplayItem[] {
  return [...items].toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      const sequenceOrder = left.sequence - right.sequence;
      if (sequenceOrder !== 0) {
        return sequenceOrder;
      }
    }
    if (left.ts !== right.ts) {
      return left.ts - right.ts;
    }
    return left.order - right.order;
  });
}

function isLaterSourceRef(
  candidate: ShellCockpitFoldedSourceRef,
  current: ShellCockpitFoldedSourceRef | null,
): boolean {
  return (
    current === null ||
    candidate.changedAt > current.changedAt ||
    (candidate.changedAt === current.changedAt && candidate.ref > current.ref)
  );
}

function isLaterAnswer(
  candidate: ShellCockpitFoldedAnswer,
  current: ShellCockpitFoldedAnswer | undefined,
): boolean {
  return (
    current === undefined ||
    candidate.ts > current.ts ||
    (candidate.ts === current.ts && candidate.latestFrameRef > current.latestFrameRef)
  );
}

function materializeRuntimeActivity(activity: MutableRuntimeActivity): ShellCockpitRuntimeActivity {
  return {
    status: activity.status,
    turnId: activity.turnId,
    attemptId: activity.attemptId,
    startedAt: activity.startedAt,
    lastProgressAt: activity.lastProgressAt,
    lastProgressRef: activity.lastProgressRef,
    promptPreview: activity.promptPreview,
    thinkingPreview: activity.thinkingPreview.trim() || null,
    progressLabel: activity.progressLabel,
    streamedChars: activity.streamedChars,
    providerBuffered: activity.providerBuffered,
  };
}

class ShellCockpitSessionWireFold {
  readonly #seenFrameKeys = new Set<string>();
  readonly #sourceClock = new Map<string, number>();
  readonly #activities = new Map<string, MutableRuntimeActivity>();
  readonly #activeTurnIds = new Set<string>();
  readonly #answerDrafts = new Map<string, MutableAnswer>();
  readonly #activeAnswerKeys = new Set<string>();
  readonly #toolCalls = new Map<string, MutableToolCall>();
  readonly #transcriptMessageIdsByTurn = new Map<string, Set<string>>();
  readonly #transcriptAssistantSegments = new Map<string, MutableTranscriptAssistantSegment>();
  #transcriptMessages: CliShellTranscriptMessage[] = [];
  #transcriptVersion = 0;
  #transcriptSegmentSequence = 0;
  #latestWireRef: ShellCockpitFoldedSourceRef | null = null;
  #latestCommittedAnswer: ShellCockpitFoldedAnswer | undefined;

  remember(frame: SessionWireFrame): void {
    const key = frameKey(frame);
    if (this.#seenFrameKeys.has(key)) {
      return;
    }
    this.#seenFrameKeys.add(key);
    this.applyFrame(frame, { projectTranscript: true });
  }

  replace(frames: readonly SessionWireFrame[]): void {
    this.#seenFrameKeys.clear();
    this.#sourceClock.clear();
    this.#activities.clear();
    this.#activeTurnIds.clear();
    this.#answerDrafts.clear();
    this.#activeAnswerKeys.clear();
    this.#toolCalls.clear();
    this.#latestWireRef = null;
    this.#latestCommittedAnswer = undefined;
    this.clearTranscriptProjection();
    for (const frame of [...frames].toSorted(compareFrames)) {
      const key = frameKey(frame);
      if (this.#seenFrameKeys.has(key)) {
        continue;
      }
      this.#seenFrameKeys.add(key);
      this.applyFrame(frame, { projectTranscript: false });
    }
    this.clearTranscriptProjection();
  }

  hydrate(frames: readonly SessionWireFrame[]): void {
    for (const frame of [...frames].toSorted(compareFrames)) {
      const key = frameKey(frame);
      if (this.#seenFrameKeys.has(key)) {
        continue;
      }
      this.#seenFrameKeys.add(key);
      this.applyFrame(frame, { projectTranscript: false });
    }
  }

  snapshot(): ShellCockpitWireFoldSnapshot {
    let runtimeActivity: ShellCockpitRuntimeActivity | null = null;
    for (const turnId of this.#activeTurnIds) {
      const candidate = this.#activities.get(turnId);
      if (!candidate || candidate.committed) {
        continue;
      }
      if (
        !runtimeActivity ||
        candidate.lastProgressAt > (runtimeActivity.lastProgressAt ?? Number.NEGATIVE_INFINITY) ||
        (candidate.lastProgressAt === runtimeActivity.lastProgressAt &&
          candidate.startedAt > (runtimeActivity.startedAt ?? Number.NEGATIVE_INFINITY)) ||
        (candidate.lastProgressAt === runtimeActivity.lastProgressAt &&
          candidate.startedAt === runtimeActivity.startedAt &&
          candidate.turnId > (runtimeActivity.turnId ?? ""))
      ) {
        runtimeActivity = materializeRuntimeActivity(candidate);
      }
    }

    let latestStreamingAnswer: ShellCockpitFoldedAnswer | undefined;
    for (const key of this.#activeAnswerKeys) {
      const candidate = this.#answerDrafts.get(key);
      if (!candidate || candidate.committed || candidate.text.trim().length === 0) {
        continue;
      }
      if (isLaterAnswer(candidate, latestStreamingAnswer)) {
        latestStreamingAnswer = {
          status: "active",
          text: candidate.text,
          turnId: candidate.turnId,
          attemptId: candidate.attemptId,
          latestFrameRef: candidate.latestFrameRef,
          ts: candidate.ts,
          startedAt: candidate.startedAt,
        };
      }
    }

    return {
      sourceClock: new Map(this.#sourceClock),
      latestWireRef: this.#latestWireRef,
      runtimeActivity,
      ...(latestStreamingAnswer ? { latestStreamingAnswer } : {}),
      ...(this.#latestCommittedAnswer
        ? { latestCommittedAnswer: this.#latestCommittedAnswer }
        : {}),
      toolCalls: [...this.#toolCalls.values()],
      transcriptVersion: this.#transcriptVersion,
      transcriptMessages: [...this.#transcriptMessages],
    };
  }

  private recordClock(ref: string, ts: number): void {
    this.#sourceClock.set(ref, ts);
    const candidate = { ref, changedAt: ts };
    if (isLaterSourceRef(candidate, this.#latestWireRef)) {
      this.#latestWireRef = candidate;
    }
  }

  private replaceClockRef(previousRef: string | undefined, nextRef: string, ts: number): void {
    if (previousRef && previousRef !== nextRef) {
      this.#sourceClock.delete(previousRef);
    }
    this.recordClock(nextRef, ts);
  }

  private ensureActivity(frame: SessionWireFrame): MutableRuntimeActivity | undefined {
    const turnId = turnIdOf(frame);
    if (!turnId) {
      return undefined;
    }
    const existing = this.#activities.get(turnId);
    if (existing) {
      this.#activeTurnIds.add(turnId);
      return existing;
    }
    const ref = frameRef(frame);
    const activity: MutableRuntimeActivity = {
      status: "waiting_provider",
      turnId,
      attemptId:
        "attemptId" in frame && typeof frame.attemptId === "string" ? frame.attemptId : null,
      startedAt: frame.ts,
      lastProgressAt: frame.ts,
      lastProgressRef: ref,
      promptPreview: null,
      thinkingPreview: "",
      progressLabel: "Waiting for provider response",
      streamedChars: 0,
      providerBuffered: true,
      committed: false,
    };
    this.#activities.set(turnId, activity);
    this.#activeTurnIds.add(turnId);
    return activity;
  }

  private answerKey(turnId: string, attemptId: string): string {
    return `${turnId}:${attemptId}`;
  }

  private updateAnswerDelta(
    frame: Extract<SessionWireFrame, { type: "assistant.delta" }>,
    activity: MutableRuntimeActivity | undefined,
  ): void {
    if (frame.lane !== "answer") {
      return;
    }
    const ref = frameRef(frame);
    const key = this.answerKey(frame.turnId, frame.attemptId);
    const current = this.#answerDrafts.get(key);
    const text = `${current?.text ?? ""}${frame.delta}`;
    const startedAt = current?.startedAt ?? activity?.startedAt;
    const next: MutableAnswer = {
      status: "active",
      committed: false,
      text,
      turnId: frame.turnId,
      attemptId: frame.attemptId,
      latestFrameRef: ref,
      ts: frame.ts,
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    this.#answerDrafts.set(key, next);
    this.#activeAnswerKeys.add(key);
    this.replaceClockRef(current?.latestFrameRef, ref, frame.ts);
  }

  private commitAnswer(frame: Extract<SessionWireFrame, { type: "turn.committed" }>): void {
    const key = this.answerKey(frame.turnId, frame.attemptId);
    const current = this.#answerDrafts.get(key);
    if (current?.latestFrameRef) {
      this.#sourceClock.delete(current.latestFrameRef);
    }
    this.#activeAnswerKeys.delete(key);
    if (frame.assistantText.trim().length === 0) {
      return;
    }
    const ref = frameRef(frame);
    const activity = this.#activities.get(frame.turnId);
    const committed: MutableAnswer = {
      status: "committed",
      committed: true,
      text: frame.assistantText,
      turnId: frame.turnId,
      attemptId: frame.attemptId,
      latestFrameRef: ref,
      ts: frame.ts,
      ...(activity ? { startedAt: activity.startedAt } : {}),
    };
    this.#answerDrafts.set(key, committed);
    if (isLaterAnswer(committed, this.#latestCommittedAnswer)) {
      this.#latestCommittedAnswer = {
        status: "committed",
        text: committed.text,
        turnId: committed.turnId,
        attemptId: committed.attemptId,
        latestFrameRef: committed.latestFrameRef,
        ts: committed.ts,
        ...(committed.startedAt !== undefined ? { startedAt: committed.startedAt } : {}),
      };
    }
  }

  private updateToolStarted(
    frame: Extract<SessionWireFrame, { type: "tool.started" }>,
  ): MutableToolCall {
    const ref = frameRef(frame);
    const current = this.#toolCalls.get(frame.toolCallId);
    const next: MutableToolCall = {
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      status: current?.status ?? "running",
      startedAt: current?.startedAt ?? frame.ts,
      startedRef: current?.startedRef ?? ref,
      latestRef: current?.latestRef ?? ref,
      latestAt: current?.latestAt ?? frame.ts,
      text: current?.text ?? "",
      verdict: current?.verdict,
      isError: current?.isError ?? false,
      display: current?.display,
    };
    this.#toolCalls.set(frame.toolCallId, next);
    this.recordClock(ref, frame.ts);
    return next;
  }

  private updateToolOutput(
    frame: Extract<SessionWireFrame, { type: "tool.progress" | "tool.finished" }>,
  ): void {
    const ref = frameRef(frame);
    const current = this.#toolCalls.get(frame.toolCallId);
    const status =
      frame.type === "tool.finished" ? (frame.isError ? "failed" : "completed") : "running";
    const next: MutableToolCall = {
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      status,
      startedAt: current?.startedAt,
      startedRef: current?.startedRef,
      latestRef: ref,
      latestAt: frame.ts,
      text: frame.text,
      verdict: frame.verdict,
      isError: frame.isError,
      display: frame.display,
    };
    this.#toolCalls.set(frame.toolCallId, next);
    if (current?.latestRef !== current?.startedRef) {
      this.replaceClockRef(current?.latestRef, ref, frame.ts);
      return;
    }
    this.recordClock(ref, frame.ts);
  }

  private clearTranscriptProjection(): void {
    this.#transcriptMessageIdsByTurn.clear();
    this.#transcriptAssistantSegments.clear();
    this.#transcriptMessages = [];
    this.#transcriptVersion += 1;
  }

  private transcriptSegmentKey(turnId: string, attemptId: string): string {
    return `${turnId}:${attemptId}`;
  }

  private recordTranscriptMessage(turnId: string, messageId: string): void {
    const current = this.#transcriptMessageIdsByTurn.get(turnId) ?? new Set<string>();
    current.add(messageId);
    this.#transcriptMessageIdsByTurn.set(turnId, current);
  }

  private upsertTranscriptMessage(turnId: string, message: CliShellTranscriptMessage | null): void {
    if (!message) {
      return;
    }
    const existingIndex = this.#transcriptMessages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    this.#transcriptMessages =
      existingIndex < 0
        ? [...this.#transcriptMessages, message]
        : [
            ...this.#transcriptMessages.slice(0, existingIndex),
            message,
            ...this.#transcriptMessages.slice(existingIndex + 1),
          ];
    this.recordTranscriptMessage(turnId, message.id);
    this.#transcriptVersion += 1;
  }

  private removeTranscriptMessagesForTurn(turnId: string): void {
    const ids = this.#transcriptMessageIdsByTurn.get(turnId);
    if (!ids) {
      return;
    }
    const nextMessages = this.#transcriptMessages.filter((message) => !ids.has(message.id));
    this.#transcriptMessageIdsByTurn.delete(turnId);
    if (nextMessages.length === this.#transcriptMessages.length) {
      return;
    }
    this.#transcriptMessages = nextMessages;
    this.#transcriptVersion += 1;
  }

  private updateTranscriptAssistantDelta(
    frame: Extract<SessionWireFrame, { type: "assistant.delta" }>,
  ): void {
    if (frame.lane !== "answer") {
      return;
    }
    const key = this.transcriptSegmentKey(frame.turnId, frame.attemptId);
    const current = this.#transcriptAssistantSegments.get(key);
    const segment =
      current ??
      ({
        turnId: frame.turnId,
        attemptId: frame.attemptId,
        messageId: transcriptAssistantMessageId({
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          attemptId: frame.attemptId,
          sequence: ++this.#transcriptSegmentSequence,
        }),
        text: "",
      } satisfies MutableTranscriptAssistantSegment);
    segment.text += frame.delta;
    this.#transcriptAssistantSegments.set(key, segment);
    if (segment.text.trim().length === 0) {
      return;
    }
    this.upsertTranscriptMessage(
      frame.turnId,
      buildTextTranscriptMessage({
        id: segment.messageId,
        role: "assistant",
        text: segment.text,
        renderMode: "streaming",
      }),
    );
  }

  private finishTranscriptAssistantSegmentsForTurn(turnId: string): void {
    for (const [key, segment] of this.#transcriptAssistantSegments) {
      if (segment.turnId !== turnId) {
        continue;
      }
      this.#transcriptAssistantSegments.delete(key);
      if (segment.text.trim().length === 0) {
        continue;
      }
      this.upsertTranscriptMessage(
        turnId,
        buildTextTranscriptMessage({
          id: segment.messageId,
          role: "assistant",
          text: segment.text,
          renderMode: "stable",
        }),
      );
    }
  }

  private upsertTranscriptToolExecution(input: {
    readonly frame: Extract<
      SessionWireFrame,
      { type: "tool.started" | "tool.progress" | "tool.finished" }
    >;
    readonly resultMode: "start" | "progress" | "finish";
  }): void {
    const frame = input.frame;
    const fallbackMessageId = transcriptToolMessageId({
      sessionId: frame.sessionId,
      turnId: frame.turnId,
      toolCallId: frame.toolCallId,
    });
    const payload =
      frame.type === "tool.started"
        ? {}
        : input.resultMode === "progress"
          ? { partialResult: buildRuntimeToolResultPayload(frame) }
          : { result: buildRuntimeToolResultPayload(frame) };
    this.#transcriptMessages = upsertToolExecutionIntoTranscriptMessages(this.#transcriptMessages, {
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      ...payload,
      status: frame.type === "tool.finished" ? (frame.isError ? "error" : "completed") : "running",
      renderMode: input.resultMode === "finish" ? "stable" : "streaming",
      fallbackMessageId,
    });
    this.recordTranscriptMessage(frame.turnId, fallbackMessageId);
    this.#transcriptVersion += 1;
  }

  private transcriptMessagesForTurn(turnId: string): CliShellTranscriptMessage[] {
    const ids = this.#transcriptMessageIdsByTurn.get(turnId);
    if (!ids) {
      return [];
    }
    return this.#transcriptMessages.filter((message) => ids.has(message.id));
  }

  private turnHasAssistantTranscript(turnId: string): boolean {
    return this.transcriptMessagesForTurn(turnId).some((message) => message.role === "assistant");
  }

  private upsertCommittedTranscriptToolOutput(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolOutput: ToolOutputView;
  }): void {
    const fallbackMessageId = transcriptToolMessageId({
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolOutput.toolCallId,
    });
    this.#transcriptMessages = upsertToolExecutionIntoTranscriptMessages(this.#transcriptMessages, {
      toolCallId: input.toolOutput.toolCallId,
      toolName: input.toolOutput.toolName,
      result: {
        content:
          input.toolOutput.text.length > 0 ? [{ type: "text", text: input.toolOutput.text }] : [],
        details: { verdict: input.toolOutput.verdict },
        ...(input.toolOutput.display ? { display: input.toolOutput.display } : {}),
        isError: input.toolOutput.isError,
      },
      status: input.toolOutput.isError ? "error" : "completed",
      renderMode: "stable",
      fallbackMessageId,
    });
    this.recordTranscriptMessage(input.turnId, fallbackMessageId);
    this.#transcriptVersion += 1;
  }

  private replayCommittedTranscript(
    frame: Extract<SessionWireFrame, { type: "turn.committed" }>,
  ): void {
    const replayItems: CommittedTranscriptReplayItem[] = [];
    let order = 0;
    const assistantSegments =
      frame.assistantSegments?.filter((segment) => segment.text.trim().length > 0) ?? [];
    for (const [index, segment] of assistantSegments.entries()) {
      replayItems.push({
        kind: "assistant",
        ts: segment.ts,
        sequence: readReplayItemSequence(segment),
        order,
        segment,
        messageId: transcriptCommittedAssistantSegmentMessageId({
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          attemptId: frame.attemptId,
          segment,
          index,
        }),
      });
      order += 1;
    }
    for (const toolOutput of frame.toolOutputs) {
      replayItems.push({
        kind: "tool",
        ts: toolOutput.ts ?? frame.ts,
        sequence: readReplayItemSequence(toolOutput),
        order,
        toolOutput,
      });
      order += 1;
    }

    this.removeTranscriptMessagesForTurn(frame.turnId);
    for (const item of sortCommittedTranscriptReplayItems(replayItems)) {
      if (item.kind === "assistant") {
        this.upsertTranscriptMessage(
          frame.turnId,
          buildTextTranscriptMessage({
            id: item.messageId,
            role: "assistant",
            text: item.segment.text,
            renderMode: "stable",
          }),
        );
        continue;
      }
      this.upsertCommittedTranscriptToolOutput({
        sessionId: frame.sessionId,
        turnId: frame.turnId,
        toolOutput: item.toolOutput,
      });
    }
  }

  private commitTranscript(frame: Extract<SessionWireFrame, { type: "turn.committed" }>): void {
    this.finishTranscriptAssistantSegmentsForTurn(frame.turnId);
    const hasCommittedAssistantSegments =
      frame.assistantSegments?.some((segment) => segment.text.trim().length > 0) ?? false;
    if (hasCommittedAssistantSegments) {
      this.replayCommittedTranscript(frame);
      return;
    }
    for (const toolOutput of frame.toolOutputs) {
      this.upsertCommittedTranscriptToolOutput({
        sessionId: frame.sessionId,
        turnId: frame.turnId,
        toolOutput,
      });
    }
    if (this.turnHasAssistantTranscript(frame.turnId) || frame.assistantText.trim().length === 0) {
      return;
    }
    this.upsertTranscriptMessage(
      frame.turnId,
      buildTextTranscriptMessage({
        id: transcriptCommittedAssistantMessageId({
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          attemptId: frame.attemptId,
        }),
        role: "assistant",
        text: frame.assistantText,
        renderMode: "stable",
      }),
    );
  }

  private applyFrame(
    frame: SessionWireFrame,
    options: { readonly projectTranscript: boolean },
  ): void {
    const ref = frameRef(frame);
    this.recordClock(ref, frame.ts);
    const activity = this.ensureActivity(frame);

    switch (frame.type) {
      case "turn.input":
        if (activity) {
          activity.status = "waiting_provider";
          activity.startedAt = frame.ts;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.promptPreview = compactPromptPreview(frame.promptText);
          activity.progressLabel = "Waiting for provider response";
          activity.providerBuffered = true;
          activity.committed = false;
        }
        break;
      case "attempt.started":
        if (activity) {
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel =
            frame.reason === "initial" ? "Provider attempt started" : frame.reason;
          activity.providerBuffered = activity.streamedChars === 0;
        }
        break;
      case "assistant.delta":
        if (activity) {
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          if (frame.lane === "answer") {
            activity.status = "streaming_answer";
            activity.streamedChars += frame.delta.length;
            activity.progressLabel = `Streaming answer (${activity.streamedChars} chars)`;
          } else {
            activity.thinkingPreview = appendThinkingPreview(activity.thinkingPreview, frame.delta);
            if (activity.latestThinkingRef && activity.latestThinkingRef !== ref) {
              this.#sourceClock.delete(activity.latestThinkingRef);
            }
            activity.latestThinkingRef = ref;
            activity.progressLabel = "Streaming thinking";
          }
          activity.providerBuffered = false;
        }
        this.updateAnswerDelta(frame, activity);
        if (options.projectTranscript) {
          this.updateTranscriptAssistantDelta(frame);
        }
        break;
      case "tool.started":
        if (activity) {
          activity.status = "running_tool";
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = `${frame.toolName} running`;
          activity.providerBuffered = false;
        }
        this.updateToolStarted(frame);
        if (options.projectTranscript) {
          this.finishTranscriptAssistantSegmentsForTurn(frame.turnId);
          this.upsertTranscriptToolExecution({ frame, resultMode: "start" });
        }
        break;
      case "tool.progress":
        if (activity) {
          activity.status = "running_tool";
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = `${frame.toolName} running`;
          activity.providerBuffered = false;
        }
        this.updateToolOutput(frame);
        if (options.projectTranscript) {
          this.finishTranscriptAssistantSegmentsForTurn(frame.turnId);
          this.upsertTranscriptToolExecution({ frame, resultMode: "progress" });
        }
        break;
      case "tool.finished":
        if (activity) {
          activity.status = "waiting_provider";
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = `${frame.toolName} finished; waiting for provider response`;
          activity.providerBuffered = activity.streamedChars === 0;
        }
        this.updateToolOutput(frame);
        if (options.projectTranscript) {
          this.finishTranscriptAssistantSegmentsForTurn(frame.turnId);
          this.upsertTranscriptToolExecution({ frame, resultMode: "finish" });
        }
        break;
      case "approval.requested":
        if (activity) {
          activity.status = "waiting_approval";
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = `${frame.toolName} waiting approval`;
          activity.providerBuffered = false;
        }
        break;
      case "approval.decided":
        if (activity) {
          activity.status = "waiting_provider";
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = `Approval ${frame.decision}; waiting for provider response`;
          activity.providerBuffered = activity.streamedChars === 0;
        }
        break;
      case "turn.transition":
        if (activity) {
          activity.attemptId = frame.attemptId ?? activity.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          if (frame.family === "recovery" || frame.family === "output_budget") {
            activity.status = frame.status === "entered" ? "recovering" : "waiting_provider";
          }
          activity.progressLabel = frame.reason;
          activity.providerBuffered =
            activity.status === "waiting_provider" && activity.streamedChars === 0;
        }
        break;
      case "turn.committed":
        if (activity) {
          activity.attemptId = frame.attemptId;
          activity.lastProgressAt = frame.ts;
          activity.lastProgressRef = ref;
          activity.progressLabel = frame.status === "failed" ? "Turn failed" : "Turn committed";
          activity.status = "idle";
          activity.providerBuffered = false;
          activity.committed = true;
          this.#activeTurnIds.delete(frame.turnId);
        }
        this.commitAnswer(frame);
        if (options.projectTranscript) {
          this.commitTranscript(frame);
        }
        break;
      case "session.closed":
        this.#activeTurnIds.clear();
        this.#activeAnswerKeys.clear();
        if (options.projectTranscript) {
          this.clearTranscriptProjection();
        }
        break;
      default:
        break;
    }
  }
}

export function createShellCockpitWireFoldStore(): {
  remember(frame: SessionWireFrame): void;
  hydrateSession(sessionId: string, frames: readonly SessionWireFrame[]): void;
  replaceSession(sessionId: string, frames: readonly SessionWireFrame[]): void;
  snapshot(sessionId: string): ShellCockpitWireFoldSnapshot;
} {
  const folds = new Map<string, ShellCockpitSessionWireFold>();
  const foldFor = (sessionId: string): ShellCockpitSessionWireFold => {
    let fold = folds.get(sessionId);
    if (!fold) {
      fold = new ShellCockpitSessionWireFold();
      folds.set(sessionId, fold);
    }
    return fold;
  };
  return {
    remember(frame) {
      foldFor(frame.sessionId).remember(frame);
    },
    hydrateSession(sessionId, frames) {
      foldFor(sessionId).hydrate(frames.filter((frame) => frame.sessionId === sessionId));
    },
    replaceSession(sessionId, frames) {
      foldFor(sessionId).replace(frames.filter((frame) => frame.sessionId === sessionId));
    },
    snapshot(sessionId) {
      return foldFor(sessionId).snapshot();
    },
  };
}

export function foldShellCockpitSessionWireFrames(input: {
  readonly sessionId: string;
  readonly frames: readonly SessionWireFrame[];
}): ShellCockpitWireFoldSnapshot {
  const fold = new ShellCockpitSessionWireFold();
  fold.replace(input.frames.filter((frame) => frame.sessionId === input.sessionId));
  return fold.snapshot();
}
