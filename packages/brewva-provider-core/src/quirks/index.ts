import type { Api, Model, Transport } from "../contracts/index.js";

// Provider wire-reality quarantine.
//
// Model-era gating and vendor synthesis quirks that the generated MODELS table
// does not (yet) carry live here — and ONLY here — so the catalog and
// cache-capability resolvers stay clean lookups instead of growing version
// regexes and `if (isXxxRoute)` ladders. A new model or compatible vendor is a
// data change in this one module, not a code change spread across abstractions.
// (RFC: "if snake_case is confined to the wire edge, vendor and deployment quirks
// are confined to the descriptor table — and nowhere else.")

// ── OpenAI Codex synthesis identity ──────────────────────────────────────────

export const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

// ── Model-era quirks (derived from a model id) ───────────────────────────────

const CODEX_LEGACY_MODEL_IDS = new Set([
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

const CODEX_EXTENDED_CONTEXT_WINDOW_MODEL = "gpt-5.5";
const CODEX_EXTENDED_CONTEXT_WINDOW = 400_000;

function isGptModelAfter54(modelId: string): boolean {
  const match = /^gpt-(\d+)\.(\d+)(?:$|[-_])/u.exec(modelId);
  if (!match) {
    return false;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  return major > 5 || (major === 5 && minor > 4);
}

/** Whether an OpenAI model id should be synthesized into an openai-codex model. */
export function isCodexEligibleModelId(modelId: string): boolean {
  return CODEX_LEGACY_MODEL_IDS.has(modelId) || isGptModelAfter54(modelId);
}

/** Context-window override for codex ids the source table under-reports. */
function codexSynthesisContextWindow(modelId: string, fallback: number): number {
  return modelId.includes(CODEX_EXTENDED_CONTEXT_WINDOW_MODEL)
    ? CODEX_EXTENDED_CONTEXT_WINDOW
    : fallback;
}

/** Whether a model id supports the `xhigh` reasoning-effort tier. */
export function modelSupportsXhigh(modelId: string): boolean {
  if (
    modelId.includes("gpt-5.2") ||
    modelId.includes("gpt-5.3") ||
    modelId.includes("gpt-5.4") ||
    modelId.includes("gpt-5.5")
  ) {
    return true;
  }
  if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) {
    return true;
  }
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

/** Derive an openai-codex model from its source OpenAI model. */
export function synthesizeCodexModel(model: Model<Api>): Model<"openai-codex-responses"> {
  return {
    id: model.id,
    name: model.name,
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    baseUrl: OPENAI_CODEX_BASE_URL,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...OPENAI_CODEX_ZERO_COST },
    contextWindow: codexSynthesisContextWindow(model.id, model.contextWindow),
    maxTokens: model.maxTokens,
  };
}

// ── Deployment descriptor + route quirks (derived from a descriptor) ──────────

// The deployment descriptor is the quarantine key: cache-capability decisions are
// resolved from this tuple rather than from URL-substring sniffing scattered across
// the resolver. Wire protocol (`api`) is not vendor (`provider`), and vendor is not
// deployment (`baseUrl`) — they are distinct descriptor fields, matched here.
//
// These predicates drive cache CAPABILITY only. Driver request-shaping keeps its
// own model-keyed route detectors (e.g. providers/openai-completions/compat.ts has
// a separate isDeepSeekRoute(model)); that vertical slice is deliberately not merged
// here — different consumer, different input (RFC vertical-slice restraint).
export interface DeploymentDescriptor {
  readonly api: Api;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly transport: Transport;
}

export function isKimiCodeRoute(descriptor: DeploymentDescriptor): boolean {
  if (descriptor.provider === "kimi-coding") {
    return true;
  }
  try {
    const url = new URL(descriptor.baseUrl);
    return url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding");
  } catch {
    return descriptor.baseUrl.includes("api.kimi.com/coding");
  }
}

export function isDeepSeekRoute(descriptor: DeploymentDescriptor): boolean {
  if (descriptor.provider === "deepseek") {
    return true;
  }
  try {
    const url = new URL(descriptor.baseUrl);
    return url.hostname === "api.deepseek.com" || url.hostname.endsWith(".deepseek.com");
  } catch {
    return descriptor.baseUrl.includes("deepseek.com");
  }
}

export function isDirectOpenAIHost(baseUrl: string): boolean {
  return baseUrl.includes("api.openai.com");
}

export function isDirectAnthropicHost(baseUrl: string): boolean {
  return baseUrl.includes("api.anthropic.com");
}

export function modelAdvertisesOpenAIPromptCacheKey(descriptor: DeploymentDescriptor): boolean {
  const { modelId } = descriptor;
  if (!modelId) {
    return false;
  }
  return (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4") ||
    modelId.startsWith("chatgpt-")
  );
}
