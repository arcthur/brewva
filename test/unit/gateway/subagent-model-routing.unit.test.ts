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

// Model choice is negotiated through the active preset (an explicit role→model
// mapping) and an advisory per-request `modelHint`, never guessed from objective
// keywords. Without a preset or a resolvable hint the router chooses no model and
// the target's own default applies downstream.
describe("subagent model routing", () => {
  test("prefers an active preset's explicit role mapping", () => {
    // deep-reasoning maps to the `slow` role; the preset maps `slow` to opus.
    const resolved = resolveDelegationModelRoute({
      target: makeTarget({ agentSpecName: "explorer" }),
      packet: { objective: "Investigate the router prefix handling." },
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

  test("honors an advisory modelHint that resolves against the registry", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget(),
      packet: {
        objective: "Investigate the router prefix handling.",
        modelHint: "openai/gpt-5.5:high",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    expect(resolved.model).toBe("openai/gpt-5.5:high");
    expect(resolved.modelRoute).toMatchObject({
      selectedModel: "openai/gpt-5.5:high",
      source: "hint",
      mode: "explicit",
    });
  });

  test("an unresolvable modelHint is ignored and falls through to the target default", () => {
    const resolved = resolveDelegationModelRoute({
      target: makeTarget(),
      packet: {
        objective: "Investigate the router prefix handling.",
        modelHint: "nonexistent/model-x",
      },
      modelRouting: {
        availableModels: [...AVAILABLE_MODELS],
      },
    });

    // No preset, hint unresolvable → the router chooses no model.
    expect([resolved.model, resolved.modelRoute]).toEqual([undefined, undefined]);
  });

  test("no preset and no hint yields no router-chosen model (and never reads target model pins)", () => {
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

  test("a preset lacking the category's role mapping surfaces a presetMissReason, not a guessed model", () => {
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
          roles: { default: "openai/gpt-5.5:high" },
        },
      } as unknown as Parameters<typeof resolveDelegationModelRoute>[0]["modelRouting"],
    });

    // verification maps to no public role; the router does NOT invent a model —
    // it surfaces the miss reason and leaves the choice to the target default.
    expect([resolved.model, resolved.modelRole]).toEqual([undefined, undefined]);
    expect(resolved.modelRoute).toMatchObject({
      source: "preset",
      mode: "auto",
      presetName: "OpenAI Stack",
      reason:
        'Preset "OpenAI Stack" has no public role mapping for delegation category "verification".',
    });
  });
});
