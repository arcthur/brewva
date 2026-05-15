import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { BrewvaModelPreset } from "@brewva/brewva-substrate/session";
import { SessionTitleCoordinator } from "../../../packages/brewva-gateway/src/hosted/internal/session/title-coordinator.js";
import { sleep, waitUntil } from "../../helpers/process.js";

const TITLE_MODEL = {
  provider: "openai",
  id: "gpt-title",
  name: "GPT Title",
  api: "openai",
  baseUrl: "https://api.openai.example/v1",
  contextWindow: 128_000,
  maxTokens: 16_384,
  reasoning: false,
  input: ["text"],
  cost: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
} satisfies BrewvaRegisteredModel;

const MAIN_MODEL = {
  ...TITLE_MODEL,
  id: "gpt-main",
  name: "GPT Main",
} satisfies BrewvaRegisteredModel;

const ALL_MODELS = [TITLE_MODEL, MAIN_MODEL] as const;

function createCatalog(options?: {
  models?: readonly BrewvaRegisteredModel[];
  hasConfiguredAuth?: (model: BrewvaRegisteredModel) => boolean;
}): BrewvaMutableModelCatalog {
  const models = options?.models ?? ALL_MODELS;
  return {
    getAll: () => [...models],
    find: (provider: string, modelId: string) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth: (model: BrewvaRegisteredModel) =>
      options?.hasConfiguredAuth?.(model) ?? true,
  } as unknown as BrewvaMutableModelCatalog;
}

function activePreset(input: { titleModel?: string; mainModel?: string } = {}): BrewvaModelPreset {
  return {
    name: "Default",
    mainModel: input.mainModel ?? "openai/gpt-main",
    delegationModels: {},
    auxiliaryModels: input.titleModel
      ? {
          title: input.titleModel,
        }
      : undefined,
  };
}

describe("SessionTitleCoordinator", () => {
  test("records one generated title for the first real user prompt", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session");
    const catalog = createCatalog();
    const preset = activePreset({ titleModel: "openai/gpt-title" });
    const generatedWith: BrewvaRegisteredModel[] = [];
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog,
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => preset,
      generator: async (input) => {
        generatedWith.push(input.model);
        return {
          title: "LLM Session Titles",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement title generation" },
      });

      await waitUntil(
        () => runtime.inspect.session.title.get(sessionId)?.title === "LLM Session Titles",
        1_000,
        "expected generated session title",
      );
      expect(runtime.inspect.session.title.get(sessionId)?.title).toBe("LLM Session Titles");
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 2,
        payload: { turnId: "turn-2", trigger: "user", promptText: "Do not rename" },
      });
      await sleep(10);

      expect(generatedWith.map((model) => model.id)).toEqual(["gpt-title"]);
      expect(runtime.inspect.session.title.get(sessionId)?.title).toBe("LLM Session Titles");
    } finally {
      unsubscribe();
    }
  });

  test("ignores non-user turn inputs before the first real user prompt", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-non-user-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-non-user");
    const generatedPrompts: string[] = [];
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog(),
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async (input) => {
        generatedPrompts.push(input.promptText);
        return {
          title: "Real User Prompt",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-schedule", trigger: "schedule", promptText: "Scheduled work" },
      });
      await sleep(10);
      expect(generatedPrompts).toEqual([]);

      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 2,
        payload: { turnId: "turn-user", trigger: "user", promptText: "User requested title" },
      });

      await waitUntil(
        () => runtime.inspect.session.title.get(sessionId)?.title === "Real User Prompt",
        1_000,
        "expected generated title after first real user prompt",
      );
      expect(generatedPrompts).toEqual(["User requested title"]);
    } finally {
      unsubscribe();
    }
  });

  test("falls back to the active preset main model when the title model is unavailable", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-main-fallback-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-main-fallback");
    const generatedWith: BrewvaRegisteredModel[] = [];
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog({ models: [MAIN_MODEL] }),
      getCurrentModel: () => TITLE_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async (input) => {
        generatedWith.push(input.model);
        return {
          title: "Main Model Title",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement title fallback" },
      });

      await waitUntil(
        () => runtime.inspect.session.title.get(sessionId)?.title === "Main Model Title",
        1_000,
        "expected generated session title from main model fallback",
      );
      expect(generatedWith.map((model) => model.id)).toEqual(["gpt-main"]);
    } finally {
      unsubscribe();
    }
  });

  test("falls back to the active preset main model when the title model lacks auth", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-auth-fallback-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-auth-fallback");
    const generatedWith: BrewvaRegisteredModel[] = [];
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog({
        hasConfiguredAuth: (model) => model.id !== "gpt-title",
      }),
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async (input) => {
        generatedWith.push(input.model);
        return {
          title: "Authenticated Main Title",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement auth fallback" },
      });

      await waitUntil(
        () => runtime.inspect.session.title.get(sessionId)?.title === "Authenticated Main Title",
        1_000,
        "expected generated session title from authenticated main model",
      );
      expect(generatedWith.map((model) => model.id)).toEqual(["gpt-main"]);
    } finally {
      unsubscribe();
    }
  });

  test("falls back to the current session model when preset models are unavailable", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-current-fallback-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-current-fallback");
    const generatedWith: BrewvaRegisteredModel[] = [];
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog({ models: [TITLE_MODEL] }),
      getCurrentModel: () => TITLE_MODEL,
      getActiveModelPreset: () =>
        activePreset({ titleModel: "openai/missing-title", mainModel: "openai/missing-main" }),
      generator: async (input) => {
        generatedWith.push(input.model);
        return {
          title: "Current Model Title",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement current fallback" },
      });

      await waitUntil(
        () => runtime.inspect.session.title.get(sessionId)?.title === "Current Model Title",
        1_000,
        "expected generated session title from current model fallback",
      );
      expect(generatedWith.map((model) => model.id)).toEqual(["gpt-title"]);
    } finally {
      unsubscribe();
    }
  });

  test("does not call the generator when no candidate has configured auth", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-no-auth-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-no-auth");
    let attempts = 0;
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog({ hasConfiguredAuth: () => false }),
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async (input) => {
        attempts += 1;
        return {
          title: "Unexpected Title",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement no auth handling" },
      });
      await sleep(10);

      expect(attempts).toBe(0);
      expect(runtime.inspect.session.title.get(sessionId)?.title ?? null).toBe(null);
    } finally {
      unsubscribe();
    }
  });

  test("does not overwrite an existing session title", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-existing-title-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-existing");
    let attempts = 0;
    runtime.authority.session.title.recordGenerated(sessionId, {
      title: "Existing Title",
      turnId: "turn-existing",
      promptEventId: "event-existing",
      model: { provider: "openai", id: "gpt-main", api: "openai" },
      generatedAt: 1,
    });
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog(),
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async (input) => {
        attempts += 1;
        return {
          title: "Unexpected Replacement",
          model: {
            provider: input.model.provider,
            id: input.model.id,
            api: input.model.api,
          },
        };
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Do not overwrite" },
      });
      await sleep(10);

      expect(attempts).toBe(0);
      expect(runtime.inspect.session.title.get(sessionId)?.title).toBe("Existing Title");
    } finally {
      unsubscribe();
    }
  });

  test("logs generator failures without retrying on later user prompts", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-title-coordinator-failure-")),
    }).hosted;
    const sessionId = asBrewvaSessionId("title-session-failure");
    let attempts = 0;
    const unsubscribe = new SessionTitleCoordinator({
      runtime,
      sessionId,
      catalog: createCatalog(),
      getCurrentModel: () => MAIN_MODEL,
      getActiveModelPreset: () => activePreset({ titleModel: "openai/gpt-title" }),
      generator: async () => {
        attempts += 1;
        throw new Error("provider_failed");
      },
    }).start();

    try {
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 1,
        payload: { turnId: "turn-1", trigger: "user", promptText: "Implement title failure path" },
      });

      await waitUntil(() => attempts === 1, 1_000, "expected failed title generation attempt");
      expect(runtime.inspect.session.title.get(sessionId)?.title ?? null).toBe(null);

      runtime.extensions.hosted.events.record({
        sessionId,
        type: "turn_input_recorded",
        turn: 2,
        payload: { turnId: "turn-2", trigger: "user", promptText: "Do not retry title" },
      });
      await sleep(10);

      expect(attempts).toBe(1);
      expect(runtime.inspect.session.title.get(sessionId)?.title ?? null).toBe(null);
    } finally {
      unsubscribe();
    }
  });
});
