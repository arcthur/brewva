import type {
  Api,
  KnownProvider,
  Model,
  OpenAICompletionsCompat,
} from "@brewva/brewva-provider-core/contracts";

export type ModelsDevCatalog = Record<string, ModelsDevProvider | undefined>;

export interface ModelsDevProvider {
  readonly models?: Record<string, ModelsDevModel | undefined>;
}

export interface ModelsDevModel {
  readonly id?: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly attachment?: boolean;
  readonly status?: string;
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
  readonly limit?: {
    readonly context?: number;
    readonly output?: number;
  };
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

export type GeneratedModelsCatalog = Record<KnownProvider, Record<string, Model<Api>>>;

export interface BuildModelsDevCatalogOptions {
  readonly preservedModelIds?: Partial<Record<KnownProvider, readonly string[]>>;
}

interface DynamicProviderConfig {
  readonly modelsDevProvider: string;
  readonly api: Api;
  readonly baseUrl: string;
  readonly includeModel: (model: ModelsDevModel) => boolean;
  readonly compat?: OpenAICompletionsCompat;
}

const PROVIDER_ORDER = [
  "anthropic",
  "github-copilot",
  "google",
  "deepseek",
  "openai",
  "openai-codex",
  "kimi-coding",
  "moonshot-cn",
  "moonshot-ai",
  "openrouter",
] as const satisfies readonly KnownProvider[];

const MOONSHOT_OPENAI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
} satisfies OpenAICompletionsCompat;

const DEFAULT_PRESERVED_MODEL_IDS = {
  openai: ["codex-mini-latest"],
} satisfies Partial<Record<KnownProvider, readonly string[]>>;

const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_$][\w$]*$/u;

const DYNAMIC_PROVIDER_CONFIGS: Partial<Record<KnownProvider, DynamicProviderConfig>> = {
  anthropic: {
    modelsDevProvider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    includeModel: isSupportedTextModel,
  },
  openai: {
    modelsDevProvider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    includeModel: isSupportedOpenAIModel,
  },
  openrouter: {
    modelsDevProvider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    includeModel: isSupportedTextModel,
  },
  "moonshot-cn": {
    modelsDevProvider: "moonshotai-cn",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    includeModel: isSupportedTextModel,
    compat: MOONSHOT_OPENAI_COMPAT,
  },
  "moonshot-ai": {
    modelsDevProvider: "moonshotai",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.ai/v1",
    includeModel: isSupportedTextModel,
    compat: MOONSHOT_OPENAI_COMPAT,
  },
} satisfies Partial<Record<KnownProvider, DynamicProviderConfig>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cloneModel(model: Model<Api>): Model<Api> {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
  };
}

function cloneModelRecord(
  models: Record<string, Model<Api>> | undefined,
): Record<string, Model<Api>> {
  const entries = Object.entries(models ?? {}).map(([modelId, model]) => [
    modelId,
    cloneModel(model),
  ]);
  return Object.fromEntries(entries);
}

function getProviderModels(
  source: ModelsDevCatalog,
  modelsDevProvider: string,
): Record<string, ModelsDevModel> {
  const provider = source[modelsDevProvider];
  if (!provider || !isObject(provider.models)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(provider.models).filter((entry): entry is [string, ModelsDevModel] =>
      isObject(entry[1]),
    ),
  );
}

function hasTextOutputOnly(model: ModelsDevModel): boolean {
  const output = model.modalities?.output ?? [];
  return output.includes("text") && output.every((modality) => modality === "text");
}

function hasTextInput(model: ModelsDevModel): boolean {
  return model.modalities?.input?.includes("text") === true;
}

function isActiveModel(model: ModelsDevModel): boolean {
  return model.status !== "alpha" && model.status !== "deprecated";
}

function isSupportedTextModel(model: ModelsDevModel): boolean {
  return isActiveModel(model) && hasTextInput(model) && hasTextOutputOnly(model);
}

function isSupportedOpenAIModel(model: ModelsDevModel): boolean {
  if (!isSupportedTextModel(model)) {
    return false;
  }

  const modelId = model.id ?? "";
  if (
    modelId.startsWith("text-embedding-") ||
    modelId.startsWith("gpt-image-") ||
    modelId.startsWith("chatgpt-image-")
  ) {
    return false;
  }

  return modelId !== "gpt-3.5-turbo" && modelId !== "o1-mini" && modelId !== "o1-preview";
}

function toBrewvaInput(model: ModelsDevModel): Model<Api>["input"] {
  return model.modalities?.input?.includes("image") === true ? ["text", "image"] : ["text"];
}

function toBrewvaModel(
  provider: KnownProvider,
  source: ModelsDevModel,
  config: DynamicProviderConfig,
): Model<Api> {
  return {
    id: source.id ?? "",
    name: source.name ?? source.id ?? "",
    api: config.api,
    provider,
    baseUrl: config.baseUrl,
    reasoning: source.reasoning === true,
    input: toBrewvaInput(source),
    cost: {
      input: readFiniteNumber(source.cost?.input),
      output: readFiniteNumber(source.cost?.output),
      cacheRead: readFiniteNumber(source.cost?.cache_read),
      cacheWrite: readFiniteNumber(source.cost?.cache_write),
    },
    contextWindow: readFiniteNumber(source.limit?.context),
    maxTokens: readFiniteNumber(source.limit?.output),
    ...(config.compat ? { compat: { ...config.compat } } : {}),
  };
}

function buildDynamicProviderModels(
  source: ModelsDevCatalog,
  provider: KnownProvider,
  config: DynamicProviderConfig,
  baseModels: Record<string, Model<Api>> | undefined,
  preservedModelIds: readonly string[],
): Record<string, Model<Api>> {
  const generatedEntries = Object.entries(getProviderModels(source, config.modelsDevProvider))
    .filter(([, model]) => model.id && config.includeModel(model))
    .map(([modelId, model]) => [modelId, toBrewvaModel(provider, model, config)] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  const generatedModels = Object.fromEntries(generatedEntries);
  for (const modelId of preservedModelIds) {
    const baseModel = baseModels?.[modelId];
    if (baseModel && !generatedModels[modelId]) {
      generatedModels[modelId] = cloneModel(baseModel);
    }
  }

  return generatedModels;
}

function resolvePreservedModelIds(
  options: BuildModelsDevCatalogOptions | undefined,
): Partial<Record<KnownProvider, readonly string[]>> {
  return {
    ...DEFAULT_PRESERVED_MODEL_IDS,
    ...options?.preservedModelIds,
  };
}

export function buildModelsDevCatalog(
  source: ModelsDevCatalog,
  baseCatalog: GeneratedModelsCatalog,
  options?: BuildModelsDevCatalogOptions,
): GeneratedModelsCatalog {
  const preservedModelIds = resolvePreservedModelIds(options);
  const catalog: Partial<GeneratedModelsCatalog> = {};

  for (const provider of PROVIDER_ORDER) {
    if (provider === "openai-codex") {
      catalog[provider] = {};
      continue;
    }

    const dynamicConfig = DYNAMIC_PROVIDER_CONFIGS[provider];
    if (dynamicConfig) {
      catalog[provider] = buildDynamicProviderModels(
        source,
        provider,
        dynamicConfig,
        baseCatalog[provider],
        preservedModelIds[provider] ?? [],
      );
      continue;
    }

    catalog[provider] = cloneModelRecord(baseCatalog[provider]);
  }

  return catalog as GeneratedModelsCatalog;
}

export function renderModelsGeneratedSource(catalog: GeneratedModelsCatalog): string {
  return [
    "// This file is auto-generated from models.dev and curated Brewva provider overrides.",
    'import type { Api, KnownProvider, Model } from "../contracts/index.js";',
    "",
    `export const MODELS = ${renderValue(catalog, 0)} satisfies Record<KnownProvider, Record<string, Model<Api>>>;`,
    "",
  ].join("\n");
}

function renderKey(key: string): string {
  return IDENTIFIER_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

function renderPrimitive(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}

function renderArray(value: readonly unknown[]): string {
  return `[${value.map((item) => renderValue(item, 0)).join(", ")}]`;
}

function renderObject(value: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const nextIndent = indent + 2;
  const lines = entries.map(
    ([key, entryValue]) =>
      `${" ".repeat(nextIndent)}${renderKey(key)}: ${renderValue(entryValue, nextIndent)},`,
  );
  return ["{", ...lines, `${" ".repeat(indent)}}`].join("\n");
}

function renderValue(value: unknown, indent: number): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return renderPrimitive(value);
  }
  if (Array.isArray(value)) {
    return renderArray(value);
  }
  if (isObject(value)) {
    return renderObject(value, indent);
  }
  throw new Error(`Unable to render generated model catalog value of type ${typeof value}`);
}
