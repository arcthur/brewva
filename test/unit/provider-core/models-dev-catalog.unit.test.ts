import { describe, expect, test } from "bun:test";
import type { Api, KnownProvider, Model } from "@brewva/brewva-provider-core/contracts";
import {
  buildModelsDevCatalog,
  renderModelsGeneratedSource,
} from "../../../script/provider-model-catalog.js";

type Catalog = Record<KnownProvider, Record<string, Model<Api>>>;

const baseCatalog = {
  anthropic: {},
  google: {},
  "google-genai": {
    "gemini-2.5-pro": {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      api: "google-genai",
      provider: "google-genai",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    },
  },
  openai: {
    "codex-mini-latest": {
      id: "codex-mini-latest",
      name: "Codex Mini",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1.5,
        output: 6,
        cacheRead: 0.375,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 100_000,
    },
  },
  "openai-codex": {
    "stale-static-model": {
      id: "stale-static-model",
      name: "Stale Static Model",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1,
      maxTokens: 1,
    },
  },
  "github-copilot": {
    "gpt-5.4": {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
    },
  },
  deepseek: {
    "deepseek-v4-flash": {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.14,
        output: 0.28,
        cacheRead: 0.0028,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    },
  },
  openrouter: {},
  "kimi-coding": {
    "kimi-for-coding": {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      api: "openai-completions",
      provider: "kimi-coding",
      baseUrl: "https://api.moonshot.cn/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 32_768,
    },
  },
  "moonshot-cn": {},
  "moonshot-ai": {},
} satisfies Catalog;

const modelsDevFixture = {
  anthropic: {
    models: {
      "claude-opus-4-7": modelFixture({
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
        context: 1_000_000,
        maxTokens: 128_000,
        inputCost: 5,
        outputCost: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      }),
    },
  },
  openai: {
    models: {
      "gpt-5.5": modelFixture({
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
        context: 1_050_000,
        maxTokens: 128_000,
        inputCost: 5,
        outputCost: 30,
        cacheRead: 0.5,
      }),
      "gpt-image-1": modelFixture({
        id: "gpt-image-1",
        name: "GPT Image 1",
        reasoning: false,
        input: ["text", "image"],
        output: ["image"],
        context: 32_000,
        maxTokens: 8_000,
        inputCost: 5,
        outputCost: 40,
      }),
      "text-embedding-3-small": modelFixture({
        id: "text-embedding-3-small",
        name: "Text Embedding 3 Small",
        reasoning: false,
        input: ["text"],
        output: ["embedding"],
        context: 8_191,
        maxTokens: 0,
        inputCost: 0.02,
        outputCost: 0,
      }),
    },
  },
  openrouter: {
    models: {
      "openai/gpt-5.1-codex": modelFixture({
        id: "openai/gpt-5.1-codex",
        name: "GPT-5.1-Codex",
        reasoning: true,
        input: ["text", "image"],
        output: ["text"],
        context: 400_000,
        maxTokens: 128_000,
        inputCost: 1.25,
        outputCost: 10,
        cacheRead: 0.125,
      }),
      "openrouter/owl-alpha": modelFixture({
        id: "openrouter/owl-alpha",
        name: "OpenRouter Owl Alpha",
        status: "alpha",
        reasoning: true,
        input: ["text"],
        output: ["text"],
        context: 200_000,
        maxTokens: 64_000,
        inputCost: 0,
        outputCost: 0,
      }),
    },
  },
  "moonshotai-cn": {
    models: {
      "kimi-k2-thinking": modelFixture({
        id: "kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        reasoning: true,
        input: ["text", "image"],
        output: ["text"],
        context: 262_144,
        maxTokens: 32_768,
        inputCost: 0,
        outputCost: 0,
      }),
    },
  },
  moonshotai: {
    models: {
      "kimi-k2-thinking": modelFixture({
        id: "kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        reasoning: true,
        input: ["text", "image"],
        output: ["text"],
        context: 262_144,
        maxTokens: 32_768,
        inputCost: 0,
        outputCost: 0,
      }),
    },
  },
  google: {
    models: {
      "gemini-1.5-pro": modelFixture({
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        reasoning: false,
        input: ["text"],
        output: ["text"],
        context: 2_000_000,
        maxTokens: 8_192,
        inputCost: 0,
        outputCost: 0,
      }),
      "gemini-embedding-001": modelFixture({
        id: "gemini-embedding-001",
        name: "Gemini Embedding 001",
        reasoning: false,
        input: ["text"],
        output: ["text"],
        context: 2_048,
        maxTokens: 1,
        inputCost: 0.15,
        outputCost: 0,
      }),
    },
  },
  deepseek: {
    models: {
      "deepseek-chat": modelFixture({
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        reasoning: false,
        input: ["text"],
        output: ["text"],
        context: 64_000,
        maxTokens: 8_192,
        inputCost: 0.27,
        outputCost: 1.1,
      }),
    },
  },
  "kimi-for-coding": {
    models: {
      k2p6: modelFixture({
        id: "k2p6",
        name: "Kimi K2.6",
        reasoning: true,
        input: ["text"],
        output: ["text"],
        context: 262_144,
        maxTokens: 32_768,
        inputCost: 0,
        outputCost: 0,
      }),
    },
  },
};

function modelFixture(options: {
  id: string;
  name: string;
  status?: string;
  reasoning: boolean;
  input: string[];
  output: string[];
  context: number;
  maxTokens: number;
  inputCost: number;
  outputCost: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  return {
    id: options.id,
    name: options.name,
    status: options.status,
    reasoning: options.reasoning,
    modalities: {
      input: options.input,
      output: options.output,
    },
    limit: {
      context: options.context,
      output: options.maxTokens,
    },
    cost: {
      input: options.inputCost,
      output: options.outputCost,
      cache_read: options.cacheRead,
      cache_write: options.cacheWrite,
    },
  };
}

describe("models.dev catalog generation", () => {
  test("generates dynamic provider catalogs and preserves curated provider catalogs", () => {
    const catalog = buildModelsDevCatalog(modelsDevFixture, baseCatalog);

    expect(catalog.anthropic["claude-opus-4-7"]).toMatchObject({
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });

    expect(catalog.openai["gpt-5.5"]).toMatchObject({
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      input: ["text", "image"],
      reasoning: true,
    });
    expect(catalog.openai["codex-mini-latest"]).toEqual(baseCatalog.openai["codex-mini-latest"]);
    expect(Object.keys(catalog.openai)).not.toContain("gpt-image-1");
    expect(Object.keys(catalog.openai)).not.toContain("text-embedding-3-small");

    expect(catalog.openrouter["openai/gpt-5.1-codex"]).toMatchObject({
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(Object.keys(catalog.openrouter)).not.toContain("openrouter/owl-alpha");

    expect(catalog["moonshot-cn"]["kimi-k2-thinking"]).toMatchObject({
      api: "openai-completions",
      provider: "moonshot-cn",
      baseUrl: "https://api.moonshot.cn/v1",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      },
    });
    expect(catalog["moonshot-ai"]["kimi-k2-thinking"]?.baseUrl).toBe("https://api.moonshot.ai/v1");

    expect(catalog.google).toEqual({});
    expect(catalog["google-genai"]["gemini-1.5-pro"]).toMatchObject({
      api: "google-genai",
      provider: "google-genai",
      baseUrl: "https://generativelanguage.googleapis.com",
      input: ["text"],
      reasoning: false,
    });
    expect(Object.keys(catalog["google-genai"])).not.toContain("gemini-embedding-001");
    expect(catalog.deepseek).toEqual(baseCatalog.deepseek);
    expect(catalog["kimi-coding"]).toEqual(baseCatalog["kimi-coding"]);
    expect(catalog["github-copilot"]).toEqual(baseCatalog["github-copilot"]);
    expect(catalog["openai-codex"]).toEqual({});
  });

  test("renders a deterministic generated source module", () => {
    const catalog = buildModelsDevCatalog(modelsDevFixture, baseCatalog);
    const source = renderModelsGeneratedSource(catalog);

    expect(source).toStartWith(
      "// This file is auto-generated from models.dev and curated Brewva provider overrides.\n",
    );
    expect(source).toContain("export const MODELS = {");
    expect(source).toContain('"openai-codex": {}');
    expect(source).toContain("satisfies Record<KnownProvider, Record<string, Model<Api>>>;");
    expect(source).toBe(renderModelsGeneratedSource(catalog));
  });
});
