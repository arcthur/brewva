import { estimateStructuredTokenCount } from "@brewva/brewva-token-estimation";

export const CLEARED_TOOL_RESULT_PLACEHOLDER = "[cleared_for_request]";
export const RECENT_TOOL_RESULT_RETAIN_COUNT = 4;
export const MIN_CLEARABLE_TOOL_RESULT_CHARS = 512;
export const DEFAULT_TAIL_PROTECT_TOKENS = 40_000;
export const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  "workbench_note",
  "workbench_evict",
  "workbench_undo_evict",
  "workbench_compact",
  "recall_search",
  "recall_curate",
  "tape_handoff",
];

interface ReductionCandidate {
  charLength: number;
  toolName?: string;
  clear: () => void;
}

export interface ReductionResult {
  payload: unknown;
  status: "completed" | "skipped";
  detail: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars: number;
  estimatedTokenSavings: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildStringCandidate(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
): ReductionCandidate | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < MIN_CLEARABLE_TOOL_RESULT_CHARS) {
    return null;
  }
  return {
    charLength: value.length,
    clear: () => {
      parent[key] = CLEARED_TOOL_RESULT_PLACEHOLDER;
    },
  };
}

function buildTextArrayCandidate(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
  input: {
    textType: string;
    buildReplacement: () => Record<string, unknown>[];
  },
): ReductionCandidate | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  let totalLength = 0;
  for (const part of value) {
    const record = asRecord(part);
    if (!record || record.type !== input.textType || typeof record.text !== "string") {
      return null;
    }
    totalLength += record.text.length;
  }
  if (totalLength < MIN_CLEARABLE_TOOL_RESULT_CHARS) {
    return null;
  }
  return {
    charLength: totalLength,
    clear: () => {
      parent[key] = input.buildReplacement();
    },
  };
}

function collectOpenAIResponsesCandidates(
  inputItems: unknown,
  candidates: ReductionCandidate[],
): void {
  if (!Array.isArray(inputItems)) {
    return;
  }
  const toolNameByCallId = new Map<string, string>();
  for (const item of inputItems) {
    const record = asRecord(item);
    if (!record || record.type !== "function_call") {
      continue;
    }
    if (typeof record.call_id === "string" && typeof record.name === "string") {
      toolNameByCallId.set(record.call_id, record.name);
    }
  }
  for (const item of inputItems) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    if (record.type !== "function_call_output") {
      continue;
    }
    const callId = typeof record.call_id === "string" ? record.call_id : undefined;
    const toolName = callId ? (toolNameByCallId.get(callId) ?? callId) : undefined;
    const stringCandidate = buildStringCandidate(record, "output", record.output);
    if (stringCandidate) {
      candidates.push({ ...stringCandidate, toolName });
      continue;
    }
    const textArrayCandidate = buildTextArrayCandidate(record, "output", record.output, {
      textType: "input_text",
      buildReplacement: () => [
        {
          type: "input_text",
          text: CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    if (textArrayCandidate) {
      candidates.push({ ...textArrayCandidate, toolName });
    }
  }
}

function collectMessageToolNameById(messages: readonly unknown[]): Map<string, string> {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }
    if (Array.isArray(record.tool_calls)) {
      for (const toolCall of record.tool_calls) {
        const toolCallRecord = asRecord(toolCall);
        if (!toolCallRecord || typeof toolCallRecord.id !== "string") {
          continue;
        }
        const functionRecord = asRecord(toolCallRecord.function);
        const name =
          typeof functionRecord?.name === "string"
            ? functionRecord.name
            : typeof toolCallRecord.name === "string"
              ? toolCallRecord.name
              : undefined;
        if (name) {
          toolNameById.set(toolCallRecord.id, name);
        }
      }
    }
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      const blockRecord = asRecord(block);
      if (
        !blockRecord ||
        (blockRecord.type !== "tool_use" && blockRecord.type !== "toolCall") ||
        typeof blockRecord.id !== "string" ||
        typeof blockRecord.name !== "string"
      ) {
        continue;
      }
      toolNameById.set(blockRecord.id, blockRecord.name);
    }
  }
  return toolNameById;
}

function collectMessageCandidates(messages: unknown, candidates: ReductionCandidate[]): void {
  if (!Array.isArray(messages)) {
    return;
  }
  const toolNameById = collectMessageToolNameById(messages);
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }

    if (record.role === "tool") {
      const toolCallId =
        typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.tool_use_id === "string"
            ? record.tool_use_id
            : undefined;
      const toolName =
        typeof record.name === "string"
          ? record.name
          : typeof record.tool_name === "string"
            ? record.tool_name
            : toolCallId
              ? toolNameById.get(toolCallId)
              : undefined;
      const stringCandidate = buildStringCandidate(record, "content", record.content);
      if (stringCandidate) {
        candidates.push({ ...stringCandidate, toolName });
      } else {
        const textArrayCandidate = buildTextArrayCandidate(record, "content", record.content, {
          textType: "text",
          buildReplacement: () => [
            {
              type: "text",
              text: CLEARED_TOOL_RESULT_PLACEHOLDER,
            },
          ],
        });
        if (textArrayCandidate) {
          candidates.push({ ...textArrayCandidate, toolName });
        }
      }
    }

    if (!Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      const blockRecord = asRecord(block);
      if (!blockRecord || blockRecord.type !== "tool_result") {
        continue;
      }
      const toolUseId =
        typeof blockRecord.tool_use_id === "string"
          ? blockRecord.tool_use_id
          : typeof blockRecord.tool_call_id === "string"
            ? blockRecord.tool_call_id
            : typeof blockRecord.id === "string"
              ? blockRecord.id
              : undefined;
      const toolName =
        typeof blockRecord.name === "string"
          ? blockRecord.name
          : typeof blockRecord.tool_name === "string"
            ? blockRecord.tool_name
            : toolUseId
              ? toolNameById.get(toolUseId)
              : undefined;
      const stringCandidate = buildStringCandidate(blockRecord, "content", blockRecord.content);
      if (stringCandidate) {
        candidates.push({ ...stringCandidate, toolName });
        continue;
      }
      const textArrayCandidate = buildTextArrayCandidate(
        blockRecord,
        "content",
        blockRecord.content,
        {
          textType: "text",
          buildReplacement: () => [
            {
              type: "text",
              text: CLEARED_TOOL_RESULT_PLACEHOLDER,
            },
          ],
        },
      );
      if (textArrayCandidate) {
        candidates.push({ ...textArrayCandidate, toolName });
      }
    }
  }
}

function collectGoogleFunctionResponseCandidates(
  contents: unknown,
  candidates: ReductionCandidate[],
): void {
  if (!Array.isArray(contents)) {
    return;
  }
  for (const content of contents) {
    const contentRecord = asRecord(content);
    if (!contentRecord || !Array.isArray(contentRecord.parts)) {
      continue;
    }
    for (const part of contentRecord.parts) {
      const partRecord = asRecord(part);
      const functionResponse = asRecord(partRecord?.functionResponse);
      if (!functionResponse) {
        continue;
      }
      const toolName =
        typeof functionResponse.name === "string" ? functionResponse.name : undefined;
      if (Array.isArray(functionResponse.parts) && functionResponse.parts.length > 0) {
        continue;
      }
      const response = asRecord(functionResponse.response);
      if (!response) {
        continue;
      }
      if (typeof response.output === "string") {
        const candidate = buildStringCandidate(response, "output", response.output);
        if (candidate) {
          candidates.push({ ...candidate, toolName });
        }
        continue;
      }
      if (typeof response.error === "string") {
        const candidate = buildStringCandidate(response, "error", response.error);
        if (candidate) {
          candidates.push({ ...candidate, toolName });
        }
      }
    }
  }
}

function collectReductionCandidates(payload: Record<string, unknown>): ReductionCandidate[] {
  const candidates: ReductionCandidate[] = [];
  collectOpenAIResponsesCandidates(payload.input, candidates);
  collectMessageCandidates(payload.messages, candidates);
  collectGoogleFunctionResponseCandidates(payload.contents, candidates);
  return candidates;
}

export function applyTransientOutboundReductionToPayload(
  payload: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
  options?: {
    protectedTools?: readonly string[];
    tailProtectTokens?: number;
  },
): ReductionResult {
  const record = asRecord(payload);
  if (!record) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload is not an object",
      eligibleToolResults: 0,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const cloned = structuredClone(record);
  const candidates = collectReductionCandidates(cloned);
  const protectedTools = new Set(options?.protectedTools ?? DEFAULT_PROTECTED_TOOLS);
  const nonProtectedCandidates = candidates.filter(
    (c) => !c.toolName || !protectedTools.has(c.toolName),
  );

  if (nonProtectedCandidates.length <= RECENT_TOOL_RESULT_RETAIN_COUNT) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload does not contain enough older compactable tool results",
      eligibleToolResults: nonProtectedCandidates.length,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const tailProtectTokens = options?.tailProtectTokens ?? DEFAULT_TAIL_PROTECT_TOKENS;
  const alwaysRetainedStart = nonProtectedCandidates.length - RECENT_TOOL_RESULT_RETAIN_COUNT;
  let tailAccum = 0;
  let firstClearableIndex = alwaysRetainedStart;
  for (let i = alwaysRetainedStart - 1; i >= 0; i -= 1) {
    tailAccum += Math.max(0, Math.trunc(nonProtectedCandidates[i]!.charLength / 4));
    if (tailAccum > tailProtectTokens) {
      firstClearableIndex = i + 1;
      break;
    }
    firstClearableIndex = i;
  }

  const clearedCandidates = nonProtectedCandidates.slice(0, firstClearableIndex);
  if (clearedCandidates.length === 0) {
    return {
      payload,
      status: "skipped",
      detail: "tail protect budget preserves all eligible candidates",
      eligibleToolResults: nonProtectedCandidates.length,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const clearedChars = clearedCandidates.reduce((sum, candidate) => sum + candidate.charLength, 0);
  for (const candidate of clearedCandidates) {
    candidate.clear();
  }
  const placeholderChars = CLEARED_TOOL_RESULT_PLACEHOLDER.length * clearedCandidates.length;

  return {
    payload: cloned,
    status: "completed",
    detail: null,
    eligibleToolResults: nonProtectedCandidates.length,
    clearedToolResults: clearedCandidates.length,
    clearedChars,
    estimatedTokenSavings: Math.max(
      0,
      estimateStructuredTokenCount("x".repeat(clearedChars), metadata) -
        estimateStructuredTokenCount("x".repeat(placeholderChars), metadata),
    ),
  };
}
