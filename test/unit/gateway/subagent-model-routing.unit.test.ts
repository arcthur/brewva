import { describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { resolveDelegationModelRoute } from "../../../packages/brewva-gateway/src/subagents/model-routing.js";
import type { HostedDelegationTarget } from "../../../packages/brewva-gateway/src/subagents/targets.js";

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

function buildAvailableModel(input: {
  provider: string;
  id: string;
  name: string;
}): RegisteredModel {
  return {
    provider: input.provider,
    id: input.id,
    name: input.name,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

const AVAILABLE_MODELS: RegisteredModel[] = [
  buildAvailableModel({
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT-5.4",
  }),
  buildAvailableModel({
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
  }),
  buildAvailableModel({
    provider: "openai",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
  }),
  buildAvailableModel({
    provider: "anthropic",
    id: "claude-opus-4.1",
    name: "Claude Opus 4.1",
  }),
];

function makeTarget(overrides: Partial<HostedDelegationTarget> = {}): HostedDelegationTarget {
  return {
    name: "advisor",
    description: "Repository advisor",
    resultMode: "consult",
    consultKind: "investigate",
    boundary: "safe",
    producesPatches: false,
    contextProfile: "minimal",
    ...overrides,
  };
}

describe("subagent model routing", () => {
  test("keeps explicit executionShape model selections inspectable", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        consultKind: "review",
      }),
      packet: {
        objective: "Review the runtime change.",
      },
      executionShape: {
        model: "openai/gpt-5.4:high",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBe("openai/gpt-5.4:high");
    expect(resolved.modelRoute).toEqual({
      selectedModel: "openai/gpt-5.4:high",
      requestedModel: "openai/gpt-5.4:high",
      source: "execution_shape",
      mode: "explicit",
      reason: "Explicit executionShape model override.",
    });
  });

  test("auto-routes execution-first patch work to the fast codex path when available", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        resultMode: "patch",
      }),
      packet: {
        objective: "Fix the failing CI patch and keep edits minimal.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBe("openai/gpt-5.3-codex-spark:high");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "openai/gpt-5.3-codex-spark:high",
      source: "policy",
      mode: "auto",
      policyId: "fast-patch-loop",
    });
  });

  test("prefers the frontend-design route when the objective is UI-heavy", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        resultMode: "patch",
      }),
      packet: {
        objective: "Refresh the React UI layout and tighten the CSS typography rhythm.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBe("anthropic/claude-opus-4.1");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "anthropic/claude-opus-4.1",
      source: "policy",
      mode: "auto",
      policyId: "frontend-design",
    });
  });

  test("does not treat substring matches as execution keywords", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        consultKind: "investigate",
      }),
      packet: {
        objective: "Inspect the prefix handling in the router before changing anything.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBeUndefined();
    expect(resolved.modelRoute).toBeUndefined();
  });

  test("lets explicit execution intent outrank frontend surface keywords", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        resultMode: "patch",
      }),
      packet: {
        objective: "Fix the React component layout without broad refactors.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBe("openai/gpt-5.3-codex-spark:high");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "openai/gpt-5.3-codex-spark:high",
      source: "policy",
      mode: "auto",
      policyId: "fast-patch-loop",
    });
  });
});
