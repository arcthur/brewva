import { isRecord } from "@brewva/brewva-std/unknown";
import { estimateTokenCount } from "../../utils/token.js";
import type { ToolExecutionOutcome } from "../kernel/port.js";
import type {
  CanonicalEvent,
  CheckpointCandidate,
  CheckpointProposalInput,
  EventId,
  MaterializationInput,
  ModelMaterializationObservation,
  ModelMaterializationObservationQuery,
  ModelPort,
  PromptContent,
  PromptContentPart,
  PromptMessage,
  PromptPlan,
  PromptToolCall,
  TapePort,
} from "../runtime-api.js";

const MAX_MATERIALIZATION_OBSERVATIONS = 512;

function checkpointSummary(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("summary" in payload)) {
    return "Committed checkpoint.";
  }
  const summary = (payload as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : "Committed checkpoint.";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function outcomeIsError(outcome: ToolExecutionOutcome): boolean {
  return outcome.kind === "err";
}

function readOutcome(value: unknown): ToolExecutionOutcome {
  const record = readRecord(value);
  if (record?.kind === "ok") {
    return { kind: "ok", value: record.value ?? null };
  }
  if (record?.kind === "err") {
    return { kind: "err", error: record.error ?? null };
  }
  if (record?.kind === "inconclusive") {
    const evidenceRefs = Array.isArray(record.evidenceRefs)
      ? record.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return {
      kind: "inconclusive",
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(record.value !== undefined ? { value: record.value } : {}),
      ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    };
  }
  throw new Error("invalid_tool_outcome");
}

function readPromptContentPart(value: unknown): PromptContentPart | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  if (record.type === "text" && typeof record.text === "string") {
    return Object.freeze({ type: "text", text: record.text });
  }
  if (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  ) {
    return Object.freeze({
      type: "image",
      data: record.data,
      mimeType: record.mimeType,
    });
  }
  if (record.type === "file" && typeof record.uri === "string") {
    return Object.freeze({
      type: "file",
      uri: record.uri,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
      ...(typeof record.displayText === "string" ? { displayText: record.displayText } : {}),
    });
  }
  return null;
}

function readPromptContent(value: unknown): readonly PromptContentPart[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: PromptContentPart[] = [];
  for (const item of value) {
    const part = readPromptContentPart(item);
    if (!part) {
      return null;
    }
    parts.push(part);
  }
  return Object.freeze(parts);
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
      return `[image:${part.mimeType}]`;
    })
    .join("");
}

function promptContentFromPayload(payload: Record<string, unknown> | null): PromptContent | null {
  const content = readPromptContent(payload?.content);
  const prompt = readString(payload?.prompt);
  if (
    content &&
    !(content.length === 1 && content[0]?.type === "text" && content[0].text === prompt)
  ) {
    return content;
  }
  return prompt;
}

function promptTextFromPayload(payload: Record<string, unknown> | null): string | null {
  const content = promptContentFromPayload(payload);
  if (typeof content === "string") {
    return content;
  }
  return content ? promptTextFromContent(content) : null;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        const record = readRecord(item);
        const text = record ? readString(record.text) : null;
        return text ? [text] : [];
      })
      .join("\n");
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function promptToolCallFromPayload(call: Record<string, unknown> | null): PromptToolCall | null {
  const toolCallId = readString(call?.toolCallId);
  const toolName = readString(call?.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }
  const args = readRecord(call?.args);
  return Object.freeze({
    toolCallId,
    toolName,
    ...(args ? { args: Object.freeze({ ...args }) } : {}),
  });
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function checkpointSummaryLimit(maxInputTokens: number | undefined): number {
  if (typeof maxInputTokens !== "number" || !Number.isFinite(maxInputTokens)) {
    return 6000;
  }
  return Math.max(48, Math.trunc(maxInputTokens * 0.8));
}

function summaryLineFromEvent(event: CanonicalEvent): string | null {
  const payload = readRecord(event.payload);
  if (event.type === "turn.started") {
    const prompt = promptTextFromPayload(payload);
    return prompt ? `user: ${truncateText(prompt, 1000)}` : null;
  }
  if (event.type === "msg.committed") {
    const text = readString(payload?.text);
    return text ? `assistant: ${truncateText(text, 1000)}` : null;
  }
  if (event.type === "reason.committed") {
    const text = readString(payload?.text);
    return text ? `reasoning: ${truncateText(text, 600)}` : null;
  }
  if (event.type === "tool.proposed") {
    const call = readRecord(payload?.call);
    const toolName = readString(call?.toolName);
    return toolName ? `tool proposed: ${toolName}` : null;
  }
  if (event.type === "tool.committed") {
    const call = readRecord(payload?.call);
    const result = readRecord(payload?.result);
    const toolName = readString(call?.toolName) ?? "tool";
    const content = textFromUnknown(result?.content);
    return `tool result (${toolName}): ${truncateText(content, 1000)}`;
  }
  if (event.type === "tool.aborted") {
    const reason = readString(payload?.reason);
    return reason ? `tool aborted: ${truncateText(reason, 600)}` : null;
  }
  return null;
}

function promptMessagesFromEvent(event: CanonicalEvent): readonly PromptMessage[] {
  const payload = readRecord(event.payload);
  if (event.type === "checkpoint.committed") {
    return [
      Object.freeze({
        role: "system" as const,
        content: checkpointSummary(event.payload),
      }),
    ];
  }
  if (event.type === "turn.started") {
    const prompt = promptContentFromPayload(payload);
    return prompt ? [Object.freeze({ role: "user" as const, content: prompt })] : [];
  }
  if (event.type === "msg.committed") {
    const text = readString(payload?.text);
    return text ? [Object.freeze({ role: "assistant" as const, content: text })] : [];
  }
  if (event.type === "tool.committed") {
    const call = readRecord(payload?.call);
    const result = readRecord(payload?.result);
    const content = textFromUnknown(result?.content);
    const toolCall = promptToolCallFromPayload(call);
    if (!toolCall) {
      return [];
    }
    const toolResult = Object.freeze({
      role: "tool" as const,
      content,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      isError: outcomeIsError(readOutcome(result?.outcome)),
    });
    return [
      Object.freeze({
        role: "assistant" as const,
        content: "",
        toolCalls: Object.freeze([toolCall]),
      }),
      toolResult,
    ];
  }
  if (event.type === "tool.aborted") {
    const call = readRecord(payload?.call);
    const reason = readString(payload?.reason);
    if (!reason) {
      return [];
    }
    const toolCall = promptToolCallFromPayload(call);
    if (!toolCall) {
      return [];
    }
    const toolResult = Object.freeze({
      role: "tool" as const,
      content: reason,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      isError: true,
    });
    return [
      Object.freeze({
        role: "assistant" as const,
        content: "",
        toolCalls: Object.freeze([toolCall]),
      }),
      toolResult,
    ];
  }
  return [];
}

function cloneMaterializationObservation(
  observation: ModelMaterializationObservation,
): ModelMaterializationObservation {
  return structuredClone(observation);
}

function filterMaterializationObservations(
  observations: readonly ModelMaterializationObservation[],
  query?: ModelMaterializationObservationQuery,
): readonly ModelMaterializationObservation[] {
  return observations
    .filter((observation) => {
      return !query?.sessionId || observation.sessionId === query.sessionId;
    })
    .map(cloneMaterializationObservation);
}

function appendMaterializationObservation(
  observations: ModelMaterializationObservation[],
  observation: ModelMaterializationObservation,
): void {
  observations.push(Object.freeze(observation));
  if (observations.length > MAX_MATERIALIZATION_OBSERVATIONS) {
    observations.splice(0, observations.length - MAX_MATERIALIZATION_OBSERVATIONS);
  }
}

export function createModelPort(tape: TapePort): ModelPort {
  const materializationObservations: ModelMaterializationObservation[] = [];
  let nextObservationSequence = 0;

  return Object.freeze({
    observe: Object.freeze({
      materialization: Object.freeze({
        list(
          query?: ModelMaterializationObservationQuery,
        ): readonly ModelMaterializationObservation[] {
          return filterMaterializationObservations(materializationObservations, query);
        },
      }),
    }),

    async materialize(input: MaterializationInput): Promise<PromptPlan> {
      const baseline = tape.replayBaseline(input.sessionId);
      const messages: PromptMessage[] = [];
      const messageSourceEventIds: EventId[] = [];
      for (const event of baseline.events) {
        for (const message of promptMessagesFromEvent(event)) {
          messages.push(message);
          messageSourceEventIds.push(event.id);
        }
      }
      const admittedBlocks = baseline.events.map((event) =>
        Object.freeze({
          id: event.id,
          kind: event.type,
          text:
            event.type === "checkpoint.committed"
              ? checkpointSummary(event.payload)
              : event.type === "turn.started"
                ? (promptTextFromPayload(readRecord(event.payload)) ?? "")
                : JSON.stringify(event.payload ?? {}),
          required: true,
        }),
      );
      const tokenEstimate = admittedBlocks.reduce(
        (sum, block) => sum + estimateTokenCount(block.text),
        0,
      );
      const maxInputTokens = input.budget?.maxInputTokens;
      const droppedAdvisoryBlocks: PromptPlan["droppedAdvisoryBlocks"] = [];
      const plan: PromptPlan = Object.freeze({
        status:
          typeof maxInputTokens === "number" && tokenEstimate > maxInputTokens
            ? "over_window"
            : "ready",
        sessionId: input.sessionId,
        messages,
        messageSourceEventIds,
        admittedBlocks,
        droppedAdvisoryBlocks,
        tokenEstimate,
        cache: { stablePrefix: Boolean(baseline.checkpoint) },
      });
      const sequence = nextObservationSequence;
      nextObservationSequence += 1;
      appendMaterializationObservation(materializationObservations, {
        id: `model-materialization:${sequence}`,
        sequence,
        timestamp: Date.now(),
        sessionId: input.sessionId,
        status: plan.status,
        sourceEventIds: baseline.events.map((event) => event.id),
        admittedBlockIds: plan.admittedBlocks.map((block) => block.id),
        droppedAdvisoryBlockIds: plan.droppedAdvisoryBlocks.map((block) => block.id),
        tokenEstimate: plan.tokenEstimate,
        cache: plan.cache,
        ...(input.budget ? { budget: structuredClone(input.budget) } : {}),
      });
      return plan;
    },

    async proposeCheckpoint(input: CheckpointProposalInput): Promise<CheckpointCandidate> {
      const baseline = tape.replayBaseline(input.sessionId);
      const summaryLines = baseline.events.flatMap((event) => {
        const line = summaryLineFromEvent(event);
        return line ? [line] : [];
      });
      const maxSummaryLength = checkpointSummaryLimit(input.budget?.maxInputTokens);
      return Object.freeze({
        sessionId: input.sessionId,
        summary:
          summaryLines.length > 0
            ? truncateText(["Committed baseline:", ...summaryLines].join("\n"), maxSummaryLength)
            : `Checkpoint for ${baseline.events.length} committed events.`,
        sourceEventIds: baseline.events.map((event) => event.id),
        eventCount: baseline.events.length,
      });
    },
  });
}
