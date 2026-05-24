import { describe, expect, test } from "bun:test";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import { resolveDelegationModelRoute } from "../../../packages/brewva-gateway/src/delegation/model-routing.js";
import type { HostedDelegationTarget } from "../../../packages/brewva-gateway/src/delegation/targets.js";

type RegisteredModel = ReturnType<BrewvaModelCatalog["getAll"]>[number];

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
    id: "gpt-5.5",
    name: "GPT-5.5",
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
    name: "explorer",
    agent: "explorer",
    targetName: "explorer",
    description: "Repository explorer",
    visibility: "public",
    resultMode: "consult",
    consultKind: "investigate",
    modelCategory: "deep-reasoning",
    gateReason: "make_judgment",
    boundary: "safe",
    producesPatches: false,
    isolationStrategy: "shared",
    ...overrides,
  };
}

describe("subagent model routing", () => {
  test("prefers active preset subagent model before policy routes", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        agentSpecName: "explorer",
        resultMode: "patch",
      }),
      packet: {
        objective: "Fix the React component layout without broad refactors.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
        activePreset: {
          name: "Claude Lead",
          roles: { slow: "anthropic/claude-opus-4.1" },
        },
      } as unknown as Parameters<typeof resolveDelegationModelRoute>[0]["modelRouting"],
    });

    expect(resolved.model).toBe("anthropic/claude-opus-4.1");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "anthropic/claude-opus-4.1",
      source: "preset",
      mode: "explicit",
      presetName: "Claude Lead",
    });
  });

  test("keeps verification category outside model-facing preset roles", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        agent: "verifier",
        targetName: "verifier",
        agentSpecName: "verifier",
        consultKind: "review",
        modelCategory: "verification",
      }),
      packet: {
        objective: "Review the runtime change.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
        activePreset: {
          name: "OpenAI Stack",
          roles: { default: "openai/gpt-5.5:high", slow: "anthropic/claude-opus-4.1" },
        },
      } as unknown as Parameters<typeof resolveDelegationModelRoute>[0]["modelRouting"],
    });

    expect(resolved.model).toBe("openai/gpt-5.5:medium");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "openai/gpt-5.5:medium",
      source: "policy",
      mode: "auto",
      policyId: "review-and-verification",
      presetMissReason:
        'Preset "OpenAI Stack" has no public role mapping for delegation category "verification".',
    });
  });

  test("does not force unknown delegation categories through the task role", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        modelCategory: "unknown-category",
        resultMode: "patch",
      }),
      packet: {
        objective: "Fix the failing CI patch and keep edits minimal.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
        activePreset: {
          name: "Task Stack",
          roles: { task: "openai/gpt-5.3-codex-spark:high" },
        },
      } as unknown as Parameters<typeof resolveDelegationModelRoute>[0]["modelRouting"],
    });

    expect(resolved.model).toBe("openai/gpt-5.3-codex-spark:high");
    expect({ modelRole: resolved.modelRole ?? null }).toEqual({ modelRole: null });
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "openai/gpt-5.3-codex-spark:high",
      source: "policy",
      policyId: "fast-patch-loop",
      category: "unknown-category",
      presetMissReason:
        'Preset "Task Stack" has no public role mapping for delegation category "unknown-category".',
    });
  });

  test("does not route from target model pins", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        model: "anthropic/claude-opus-4.1",
      } as Partial<HostedDelegationTarget> & { model: string }),
      packet: {
        objective: "Inspect the prefix handling in the router before changing anything.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect([resolved.model, resolved.modelRoute]).toEqual([undefined, undefined]);
  });

  test("does not accept explicit executionShape model selections", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({
        consultKind: "review",
      }),
      packet: {
        objective: "Review the runtime change.",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.modelRoute).toMatchObject({
      source: "policy",
      policyId: "review-and-verification",
      category: "deep-reasoning",
    });
    expect(resolved.modelRoute?.source).not.toBe("execution_shape");
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
    expect(resolved.modelRole).toBe("slow");
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

    expect([resolved.model, resolved.modelRoute]).toEqual([undefined, undefined]);
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
