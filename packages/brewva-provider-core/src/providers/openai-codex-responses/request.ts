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

  if (
    stableStringify(stripRequestInput(continuation.previousRequest)) !==
    stableStringify(stripRequestInput(body))
  ) {
    return body;
  }

  const previousInput = normalizeResponseInput(continuation.previousRequest.input);
  const previousOutput = normalizeResponseInput(continuation.lastResponse.outputItems);
  const currentInput = normalizeResponseInput(body.input);
  const baseline = [...previousInput, ...previousOutput];
  if (!responseInputStartsWith(currentInput, baseline)) {
    return body;
  }

  return {
    ...body,
    previous_response_id: responseId,
    input: currentInput.slice(baseline.length),
  };
}

function stripRequestInput(body: RequestBody): Record<string, unknown> {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
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
    if (stableStringify(left) !== stableStringify(right)) {
      return false;
    }
  }
  return true;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = normalizeStable((value as Record<string, unknown>)[key]);
  }
  return output;
}

function clampReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) &&
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
