import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import { loadHostedDelegationCatalog } from "../../../packages/brewva-gateway/src/delegation/catalog/registry.js";
import {
  assertDelegationShapeNarrowing,
  resolveDelegationExecutionPlan,
} from "../../../packages/brewva-gateway/src/delegation/execution-plan.js";
import { resolveDelegationTarget } from "../../../packages/brewva-gateway/src/delegation/target-resolution.js";
import type { HostedDelegationTarget } from "../../../packages/brewva-gateway/src/delegation/targets.js";

function makeTarget(overrides: Partial<HostedDelegationTarget> = {}): HostedDelegationTarget {
  return {
    name: "explorer",
    agent: "explorer",
    targetName: "explorer",
    description: "Read-only explorer",
    visibility: "public",
    resultMode: "consult",
    consultKind: "review",
    modelCategory: "deep-reasoning",
    gateReason: "make_judgment",
    executorPreamble: "Review and summarize.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: ["grep"],
    managedToolMode: "direct",
    producesPatches: false,
    isolationStrategy: "shared",
    ...overrides,
  };
}

function buildAvailableModel(input: {
  provider: string;
  id: string;
  name: string;
}): ReturnType<BrewvaModelCatalog["getAll"]>[number] {
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

async function expectCatalogLoadToReject(workspace: string, message: string): Promise<void> {
  let thrown: unknown;
  try {
    await loadHostedDelegationCatalog(workspace);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(message);
}

describe("subagent shared execution resolution", () => {
  test("assertDelegationShapeNarrowing rejects widening overrides", () => {
    const target = makeTarget();

    expect(() =>
      assertDelegationShapeNarrowing(target, {
        boundary: "effectful",
      }),
    ).toThrow("subagent_effect_ceiling_widening_not_allowed");
    expect(() =>
      assertDelegationShapeNarrowing(target, {
        managedToolMode: "hosted",
      }),
    ).toThrow("subagent_managed_tool_mode_widening_not_allowed");
  });

  test("resolveDelegationExecutionPlan shares execution hint assembly between caller paths", () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-subagent-shared-plan-")),
    }).hosted;
    const target = makeTarget({
      boundary: "effectful",
      builtinToolNames: ["read"],
      managedToolNames: [],
    });

    const plan = resolveDelegationExecutionPlan({
      runtime,
      target,
      packet: {
        objective: "Review the gateway deltas.",
        consultBrief: {
          decision: "What is the strongest review judgment on the gateway deltas?",
          successCriteria: "Return an evidence-backed second opinion for the parent.",
        },
        executionHints: {
          preferredTools: ["edit", "grep"],
          fallbackTools: ["write", "subagent_run"],
        },
      },
      executionShape: {
        boundary: "safe",
      },
      modelRouting: {
        availableModels: [
          buildAvailableModel({
            provider: "openai",
            id: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
          }),
        ],
        activePreset: {
          name: "Test",
          delegationModels: {
            "deep-reasoning": "openai/gpt-5.4-mini",
          },
        },
      },
    });

    expect(plan.boundary).toBe("safe");
    expect(plan.model).toBe("openai/gpt-5.4-mini");
    expect(plan.modelRoute).toEqual({
      selectedModel: "openai/gpt-5.4-mini",
      category: "deep-reasoning",
      source: "preset",
      mode: "explicit",
      reason: 'Model selected by preset "Test" for delegation category "deep-reasoning".',
      presetName: "Test",
    });
    expect(plan.managedToolMode).toBe("direct");
    expect(plan.builtinToolNames).toEqual(["read"]);
    expect(plan.managedToolNames).toEqual([]);
    expect(plan.managedToolNames).not.toContain("subagent_run");
    expect(plan.prompt).toBe("Review and summarize.");
  });

  test("resolveDelegationExecutionPlan rejects consult runs without consultBrief", () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-subagent-shared-missing-brief-")),
    }).hosted;

    expect(() =>
      resolveDelegationExecutionPlan({
        runtime,
        target: makeTarget({
          agentSpecName: "explorer",
          envelopeName: "explorer-readonly",
        }),
        packet: {
          objective: "Review the gateway deltas.",
        },
      }),
    ).toThrow("missing_consult_brief");
  });

  test("resolveDelegationTarget derives a default agent spec from the public agent role", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "verifier",
        executionShape: {
          boundary: "safe",
        },
      },
    });

    expect(resolved.delegate).toBe("verifier");
    expect(resolved.target.resultMode).toBe("verifier");
  });

  test("resolveDelegationTarget routes discovery through navigator evidence", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "navigator",
        skillName: "discovery",
      },
    });

    expect(resolved.delegate).toBe("navigator");
    expect(resolved.target.agentSpecName).toBe("navigator");
    expect(resolved.target.skillName).toBe("discovery");
    expect(resolved.target.resultMode).toBe("evidence");
    expect(resolved.target.consultKind).toBe(undefined);
  });

  test("resolveDelegationTarget routes architecture through explorer design consults", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "explorer",
        skillName: "architecture",
      },
    });

    expect(resolved.delegate).toBe("explorer");
    expect(resolved.target.agentSpecName).toBe("explorer");
    expect(resolved.target.skillName).toBe("architecture");
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("design");
  });

  test("resolveDelegationTarget routes office-hours through explorer design consults", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "explorer",
        skillName: "office-hours",
      },
    });

    expect(resolved.delegate).toBe("explorer");
    expect(resolved.target.agentSpecName).toBe("explorer");
    expect(resolved.target.skillName).toBe("office-hours");
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("design");
  });

  test("resolveDelegationTarget materializes an agent spec through the catalog", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "explorer",
        consultKind: "review",
      },
    });

    expect(resolved.delegate).toBe("explorer");
    expect(resolved.target.agentSpecName).toBe("explorer");
    expect(resolved.target.envelopeName).toBe("explorer-readonly");
    expect(resolved.target.skillName).toBe(undefined);
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("review");
  });

  test("resolveDelegationTarget rejects explorer runs without an explicit consultKind", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agent: "explorer",
        },
      }),
    ).toThrow("missing_consult_kind");
  });

  test("resolveDelegationTarget supports built-in review lane delegates", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "explorer",
        targetName: "review-security",
      },
    });

    expect(resolved.delegate).toBe("review-security");
    expect(resolved.target.agentSpecName).toBe("review-security");
    expect(resolved.target.envelopeName).toBe("explorer-readonly");
    expect(resolved.target.skillName).toBe(undefined);
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("review");
  });

  test("resolveDelegationTarget rejects unknown target names", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agent: "explorer",
          targetName: "does-not-exist",
        },
      }),
    ).toThrow("unknown_agent_spec:does-not-exist");
  });

  test("resolveDelegationTarget fails fast on unknown target names", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agent: "explorer",
          targetName: "does-not-exist",
        },
      }),
    ).toThrow("unknown_agent_spec:does-not-exist");
  });

  test("resolveDelegationTarget resolves a markdown custom specialist by agent spec name", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-spec-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "security-explorer.md"),
      [
        "---",
        'name: "security-explorer"',
        'description: "Workspace security explorer"',
        'extends: "explorer"',
        'tools: ["grep", "read_spans"]',
        "---",
        "Focus on security-relevant evidence.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agent: "explorer",
        targetName: "security-explorer",
        consultKind: "review",
      },
    });

    expect(resolved.delegate).toBe("security-explorer");
    expect(resolved.target.agentSpecName).toBe("security-explorer");
    expect(resolved.target.envelopeName).toBe("explorer-readonly");
    expect(resolved.target.managedToolNames).toEqual(["grep", "read_spans"]);
  });

  test("resolveDelegationTarget rejects legacy workspace envelope configs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-envelope-narrow-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-explorer.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "tight-explorer",
          extends: "explorer-readonly",
          description: "Narrowed explorer envelope",
          managedToolNames: ["grep", "read_spans", "look_at"],
          defaultContextBudget: {
            maxTurnTokens: 3200,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expectCatalogLoadToReject(workspace, "JSON subagent configs are no longer supported");
  });

  test("resolveDelegationTarget rejects target names that do not match the selected role", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agent: "verifier",
          targetName: "review-security",
        },
      }),
    ).toThrow("incompatible_agent_spec_role:review-security:verifier");
  });
});
