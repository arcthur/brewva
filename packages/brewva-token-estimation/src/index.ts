import {
  countTokens as countCl100kTokens,
  decode as decodeCl100kTokens,
  encode as encodeCl100kTokens,
} from "gpt-tokenizer/encoding/cl100k_base";
import {
  countTokens as countO200kTokens,
  decode as decodeO200kTokens,
  encode as encodeO200kTokens,
} from "gpt-tokenizer/encoding/o200k_base";

export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
}

export type BrewvaTokenEncoding = "o200k_base" | "cl100k_base";
export type BrewvaTokenEstimateMethod = "gpt_bpe" | "gpt_bpe_approximation";

export interface TokenEstimatorHints {
  api?: string | null;
  provider?: string | null;
  modelId?: string | null;
  encoding?: BrewvaTokenEncoding | null;
}

export interface ProviderPayloadTokenEstimateMetadata {
  provider?: string | null;
  api?: string | null;
  modelId?: string | null;
}

export interface BrewvaTokenEstimate {
  tokens: number;
  encoding: BrewvaTokenEncoding;
  method: BrewvaTokenEstimateMethod;
  approximation: boolean;
  provider?: string;
  api?: string;
  modelId?: string;
}

export type CachePostureStatus =
  | "unknown"
  | "cold"
  | "warm"
  | "break"
  | "limited"
  | "unsupported"
  | "degraded";

export interface CachePostureInput {
  readonly status?: string | null;
  readonly bucketKey?: string | null;
  readonly stablePrefixHash?: string | null;
  readonly dynamicTailHash?: string | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly supported?: boolean | null;
  readonly reason?: string | null;
}

export interface CachePosture {
  readonly status: CachePostureStatus;
  readonly bucketKey: string | null;
  readonly stablePrefixHash: string | null;
  readonly dynamicTailHash: string | null;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly supported: boolean;
  readonly reason: string | null;
}

interface TokenCodec {
  countTokens(text: string): number;
  encode(text: string): number[];
  decode(tokens: number[]): string;
}

interface ResolvedTokenEstimator {
  encoding: BrewvaTokenEncoding;
  method: BrewvaTokenEstimateMethod;
  approximation: boolean;
  codec: TokenCodec;
}

const CODECS: Record<BrewvaTokenEncoding, TokenCodec> = {
  o200k_base: {
    countTokens: countO200kTokens,
    encode: encodeO200kTokens,
    decode: decodeO200kTokens,
  },
  cl100k_base: {
    countTokens: countCl100kTokens,
    encode: encodeCl100kTokens,
    decode: decodeCl100kTokens,
  },
};

const LEGACY_CL100K_MODEL_PATTERNS: readonly RegExp[] = [
  /^gpt-3(?:\.5)?(?:-|$)/u,
  /^gpt-4(?:-|$)/u,
  /^text-(?:davinci|curie|babbage|ada)(?:-|$)/u,
  /^text-embedding-(?:ada|3)(?:-|$)/u,
  /(?:^|-)turbo(?:-|$)/u,
];

function normalizeLower(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isOpenAiFamily(hints: TokenEstimatorHints): boolean {
  const api = normalizeLower(hints.api);
  const provider = normalizeLower(hints.provider);
  const modelId = normalizeLower(hints.modelId);
  if (
    api === "openai-responses" ||
    api === "openai-completions" ||
    api === "openai-codex-responses"
  ) {
    return true;
  }
  if (provider === "openai" || provider === "openai-codex") {
    return true;
  }
  return /^(?:gpt-|chatgpt-|o\d(?:-|$)|codex(?:-|$))/u.test(modelId);
}

function resolveEncoding(hints: TokenEstimatorHints): BrewvaTokenEncoding {
  if (hints.encoding === "o200k_base" || hints.encoding === "cl100k_base") {
    return hints.encoding;
  }

  const modelId = normalizeLower(hints.modelId);
  if (modelId && LEGACY_CL100K_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))) {
    return "cl100k_base";
  }
  return "o200k_base";
}

export function resolveModelTokenEstimator(
  hints: TokenEstimatorHints = {},
): ResolvedTokenEstimator {
  const encoding = resolveEncoding(hints);
  const approximation = !isOpenAiFamily(hints);
  return {
    encoding,
    method: approximation ? "gpt_bpe_approximation" : "gpt_bpe",
    approximation,
    codec: CODECS[encoding],
  };
}

function optionalMetadata(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function optionalPostureString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeCachePostureStatus(value: string | null | undefined): CachePostureStatus {
  switch (value?.trim().toLowerCase()) {
    case "cold":
    case "warm":
    case "break":
    case "limited":
    case "unsupported":
    case "degraded":
      return value.trim().toLowerCase() as CachePostureStatus;
    default:
      return "unknown";
  }
}

function nonNegativeInteger(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function resolveCachePosture(input: CachePostureInput | null | undefined): CachePosture {
  if (!input) {
    return {
      status: "unknown",
      bucketKey: null,
      stablePrefixHash: null,
      dynamicTailHash: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      supported: false,
      reason: "missing_observation",
    };
  }

  const status = normalizeCachePostureStatus(input.status);
  return {
    status,
    bucketKey: optionalPostureString(input.bucketKey),
    stablePrefixHash: optionalPostureString(input.stablePrefixHash),
    dynamicTailHash: optionalPostureString(input.dynamicTailHash),
    cacheReadTokens: nonNegativeInteger(input.cacheReadTokens),
    cacheWriteTokens: nonNegativeInteger(input.cacheWriteTokens),
    supported: input.supported ?? (status !== "unknown" && status !== "unsupported"),
    reason: optionalPostureString(input.reason),
  };
}

export function estimateModelTokens(
  text: string,
  hints: TokenEstimatorHints = {},
): BrewvaTokenEstimate {
  const resolved = resolveModelTokenEstimator(hints);
  return {
    tokens: Math.max(0, resolved.codec.countTokens(text)),
    encoding: resolved.encoding,
    method: resolved.method,
    approximation: resolved.approximation,
    provider: optionalMetadata(hints.provider),
    api: optionalMetadata(hints.api),
    modelId: optionalMetadata(hints.modelId),
  };
}

export function estimateTokenCount(text: string, hints: TokenEstimatorHints = {}): number {
  return estimateModelTokens(text, hints).tokens;
}

export function estimateStructuredModelTokens(
  value: unknown,
  hints: TokenEstimatorHints = {},
): BrewvaTokenEstimate {
  if (typeof value === "string") {
    return estimateModelTokens(value, hints);
  }
  const serialized = JSON.stringify(value);
  return estimateModelTokens(serialized ?? "", hints);
}

export function estimateStructuredTokenCount(value: unknown, hints?: TokenEstimatorHints): number {
  return estimateStructuredModelTokens(value, hints).tokens;
}

const NON_TEXTUAL_PAYLOAD_TYPES = new Set([
  "image",
  "image_url",
  "image_file",
  "input_image",
  "input_audio",
  "audio",
  "video",
  "file",
  "file_data",
]);

const NON_TEXTUAL_PAYLOAD_KEYS = new Set([
  "image",
  "image_url",
  "imageUrl",
  "image_file",
  "imageFile",
  "input_image",
  "inputImage",
  "input_audio",
  "inputAudio",
  "audio",
  "video",
  "file",
  "file_data",
  "fileData",
]);

const NON_TEXTUAL_STRING_KEYS = new Set([
  "data",
  "bytes",
  "b64_json",
  "base64",
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
]);

const LOW_SIGNAL_PROVIDER_PAYLOAD_STRING_KEYS = new Set([
  "model",
  "provider",
  "type",
  "id",
  "call_id",
  "tool_call_id",
  "response_id",
  "sessionId",
  "session_id",
  "cachePolicy",
  "cache_policy",
  "transport",
  "tool_choice",
  "parallel_tool_calls",
  "encoding",
  "format",
  "role",
]);

interface PayloadStringContext {
  parent?: Record<string, unknown>;
  key?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isNonTextualPayloadRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : null;
  if (type && NON_TEXTUAL_PAYLOAD_TYPES.has(type)) {
    return true;
  }
  for (const key of NON_TEXTUAL_PAYLOAD_KEYS) {
    if (key in record) {
      return true;
    }
  }
  return false;
}

function shouldCountProviderPayloadString(value: string, context: PayloadStringContext): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  const key = context.key;
  if (key && LOW_SIGNAL_PROVIDER_PAYLOAD_STRING_KEYS.has(key)) {
    return false;
  }
  if (key && NON_TEXTUAL_STRING_KEYS.has(key)) {
    return false;
  }
  if (context.parent && isNonTextualPayloadRecord(context.parent)) {
    return false;
  }
  return true;
}

function deriveProviderPayloadTokenEstimatorHints(
  payload: unknown,
  metadata?: ProviderPayloadTokenEstimateMetadata,
): TokenEstimatorHints {
  const record = asRecord(payload);
  const modelId =
    metadata?.modelId ??
    (record && typeof record.model === "string"
      ? record.model
      : record && typeof record.modelId === "string"
        ? record.modelId
        : null);
  const api =
    metadata?.api ??
    (record && typeof record.api === "string"
      ? record.api
      : record && typeof record.providerApi === "string"
        ? record.providerApi
        : null);
  return {
    api,
    provider: metadata?.provider,
    modelId,
  };
}

function estimateProviderPayloadTextTokensInner(
  value: unknown,
  context: PayloadStringContext,
  hints: TokenEstimatorHints,
): number {
  if (typeof value === "string") {
    return shouldCountProviderPayloadString(value, context)
      ? estimateStructuredTokenCount(value, hints)
      : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, entry) =>
        sum + estimateProviderPayloadTextTokensInner(entry, { parent: context.parent }, hints),
      0,
    );
  }

  const record = asRecord(value);
  if (!record) {
    return 0;
  }
  if (isNonTextualPayloadRecord(record)) {
    return 0;
  }

  let total = 0;
  for (const [key, entry] of Object.entries(record)) {
    total += estimateProviderPayloadTextTokensInner(entry, { parent: record, key }, hints);
  }
  return total;
}

export function estimateProviderPayloadTextTokens(
  payload: unknown,
  metadata?: ProviderPayloadTokenEstimateMetadata,
): number {
  return estimateProviderPayloadTextTokensInner(
    payload,
    {},
    deriveProviderPayloadTokenEstimatorHints(payload, metadata),
  );
}

export function normalizePercent(
  value: number | null | undefined,
  options?: {
    tokens?: number | null;
    contextWindow?: number | null;
  },
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;

  const raw = value;
  const tokens = options?.tokens;
  const contextWindow = options?.contextWindow;
  const hasTokenTelemetry =
    typeof tokens === "number" &&
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0;
  const usageRatioFromTelemetry = hasTokenTelemetry
    ? Math.max(0, Math.min(tokens / contextWindow, 1))
    : null;

  let normalized = raw;
  if (raw > 1) {
    normalized = raw / 100;
  } else if (usageRatioFromTelemetry !== null) {
    const pointsFromTelemetry = usageRatioFromTelemetry * 100;
    const distanceAsRatio = Math.abs(raw - usageRatioFromTelemetry);
    const distanceAsPoints = Math.abs(raw - pointsFromTelemetry);
    normalized = distanceAsPoints < distanceAsRatio ? raw / 100 : raw;
  }

  return Math.max(0, Math.min(normalized, 1));
}

export function resolveContextUsageRatio(
  input: ContextUsageLike | null | undefined,
): number | null {
  if (!input) return null;

  const normalizedPercent = normalizePercent(input.percent, {
    tokens: input.tokens,
    contextWindow: input.contextWindow,
  });
  if (normalizedPercent !== null) {
    return normalizedPercent;
  }

  if (typeof input.tokens !== "number" || !Number.isFinite(input.tokens) || input.tokens < 0) {
    return null;
  }
  if (
    typeof input.contextWindow !== "number" ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.min(1, input.tokens / input.contextWindow));
}

export function resolveContextUsageTokens(
  input: ContextUsageLike | null | undefined,
): number | null {
  if (!input) return null;

  if (typeof input.tokens === "number" && Number.isFinite(input.tokens) && input.tokens >= 0) {
    return Math.ceil(input.tokens);
  }

  if (
    typeof input.contextWindow !== "number" ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0
  ) {
    return null;
  }

  const ratio = resolveContextUsageRatio(input);
  if (ratio === null) {
    return null;
  }
  return Math.ceil(ratio * input.contextWindow);
}

function safeDecodePrefix(codec: TokenCodec, tokens: readonly number[]): string {
  return codec.decode([...tokens]).replace(/[\ud800-\udfff]/gu, "");
}

export function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  hints: TokenEstimatorHints = {},
): string {
  const cappedBudget = Math.max(0, Math.floor(tokenBudget));
  if (cappedBudget <= 0 || text.length === 0) {
    return "";
  }

  const resolved = resolveModelTokenEstimator(hints);
  const encoded = resolved.codec.encode(text);
  if (encoded.length <= cappedBudget) {
    return text;
  }

  const ellipsis = "...";
  const ellipsisTokens = resolved.codec.encode(ellipsis);
  if (ellipsisTokens.length >= cappedBudget) {
    return safeDecodePrefix(resolved.codec, encoded.slice(0, cappedBudget));
  }

  const prefixBudget = cappedBudget - ellipsisTokens.length;
  const prefix = safeDecodePrefix(resolved.codec, encoded.slice(0, prefixBudget));
  const candidate = `${prefix}${ellipsis}`;
  if (estimateTokenCount(candidate, hints) <= cappedBudget) {
    return candidate;
  }

  return safeDecodePrefix(resolved.codec, encoded.slice(0, cappedBudget));
}

export const truncateTextToModelTokenBudget = truncateTextToTokenBudget;
