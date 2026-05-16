import { stableJsonStringify } from "@brewva/brewva-std/json";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { resolveOpenAIResponsesCacheRender } from "../../cache/render/openai-responses.js";
import type { Context, Model } from "../../contracts/index.js";
import { convertResponsesMessages } from "../openai-responses/messages.js";
import { convertResponsesTools } from "../openai-responses/tools.js";
import type {
  CodexContinuationState,
  OpenAICodexResponsesOptions,
  RequestBody,
} from "./contract.js";

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function buildRequestBody(
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
): RequestBody {
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
  });
  const cacheRender = resolveOpenAIResponsesCacheRender({
    api: "openai-codex-responses",
    baseUrl: model.baseUrl,
    provider: model.provider,
    modelId: model.id,
    transport: options?.transport,
    sessionId: options?.sessionId,
    policy: options?.cachePolicy,
  });
  void options?.onCacheRender?.(cacheRender, model);

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt,
    input: messages,
    text: { verbosity: options?.textVerbosity || "medium" },
    include: ["reasoning.encrypted_content"],
    ...(cacheRender.promptCacheKey ? { prompt_cache_key: cacheRender.promptCacheKey } : {}),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (context.tools) {
    body.tools = convertResponsesTools(context.tools, { strict: null });
  }

  if (options?.reasoningEffort !== undefined) {
    body.reasoning = {
      effort: clampReasoningEffort(model.id, options.reasoningEffort),
      summary: options.reasoningSummary ?? "auto",
    };
  }

  return body;
}

export function buildCodexContinuationRequest(
  body: RequestBody,
  continuation: CodexContinuationState | undefined,
  explicitPreviousResponseId?: string,
): RequestBody {
  const responseId = continuation?.lastResponse.responseId || explicitPreviousResponseId;
  if (!responseId) {
    return body;
  }

  if (!continuation) {
    return {
      ...body,
      previous_response_id: responseId,
    };
  }

  if (continuation.model !== body.model) {
    return body;
  }

  const previousInput = normalizeResponseInput(continuation.previousRequest.input);
  const previousOutput = normalizeResponseInput(continuation.lastResponse.outputItems);
  const currentInput = normalizeResponseInput(body.input);
  const baseline = [...previousInput, ...previousOutput];
  if (responseInputStartsWith(currentInput, baseline)) {
    return {
      ...body,
      previous_response_id: responseId,
      input: currentInput.slice(baseline.length),
    };
  }

  return body;
}

function normalizeResponseInput(input: ResponseInput | undefined): ResponseInput {
  return Array.isArray(input) ? input : [];
}

function responseInputStartsWith(input: ResponseInput, prefix: ResponseInput): boolean {
  if (prefix.length > input.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    const left = input[index];
    const right = prefix[index];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (!responseInputItemsMatchForContinuation(left, right)) {
      return false;
    }
  }
  return true;
}

function responseInputItemsMatchForContinuation(
  left: ResponseInput[number],
  right: ResponseInput[number],
): boolean {
  if (stableJsonStringify(left) === stableJsonStringify(right)) {
    return true;
  }
  if (responseInputItemsHaveSameProtocolIdentity(left, right)) {
    return true;
  }
  return (
    stableJsonStringify(normalizeContinuationComparableItem(left)) ===
    stableJsonStringify(normalizeContinuationComparableItem(right))
  );
}

function responseInputItemsHaveSameProtocolIdentity(
  left: ResponseInput[number],
  right: ResponseInput[number],
): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return false;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  if (leftRecord.type !== rightRecord.type) {
    return false;
  }

  const leftId = readNonEmptyString(leftRecord.id);
  const rightId = readNonEmptyString(rightRecord.id);
  if (leftId && rightId) {
    return leftId === rightId;
  }

  if (leftRecord.type === "function_call" || leftRecord.type === "function_call_output") {
    const leftCallId = readNonEmptyString(leftRecord.call_id);
    const rightCallId = readNonEmptyString(rightRecord.call_id);
    return Boolean(leftCallId && rightCallId && leftCallId === rightCallId);
  }

  return false;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeContinuationComparableItem(item: ResponseInput[number]): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const normalized = { ...(item as unknown as Record<string, unknown>) };
  delete normalized.status;
  return normalized;
}

function clampReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  if (
    (id.startsWith("gpt-5.2") ||
      id.startsWith("gpt-5.3") ||
      id.startsWith("gpt-5.4") ||
      id.startsWith("gpt-5.5")) &&
    effort === "minimal"
  )
    return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini")
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

export function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}
