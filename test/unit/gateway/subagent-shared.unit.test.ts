import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import { loadHostedDelegationCatalog } from "../../../packages/brewva-gateway/src/subagents/catalog.js";
import {
  assertDelegationShapeNarrowing,
  resolveDelegationExecutionPlan,
  resolveDelegationTarget,
} from "../../../packages/brewva-gateway/src/subagents/shared.js";
import type { HostedDelegationTarget } from "../../../packages/brewva-gateway/src/subagents/targets.js";

function makeTarget(overrides: Partial<HostedDelegationTarget> = {}): HostedDelegationTarget {
  return {
    name: "advisor",
    description: "Read-only advisor",
    visibility: "public",
    resultMode: "consult",
    consultKind: "review",
    executorPreamble: "Review and summarize.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: ["grep"],
    managedToolMode: "direct",
    producesPatches: false,
    contextProfile: "minimal",
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
        resultMode: "patch",
      }),
    ).toThrow("subagent_result_mode_override_not_allowed");
    expect(() =>
      assertDelegationShapeNarrowing(target, {
        managedToolMode: "runtime_plugin",
      }),
    ).toThrow("subagent_managed_tool_mode_widening_not_allowed");
  });

  test("resolveDelegationExecutionPlan shares execution hint assembly between caller paths", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-subagent-shared-plan-")),
    });
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
        model: "openai/gpt-5.4-mini",
      },
      modelRouting: {
        availableModels: [
          buildAvailableModel({
            provider: "openai",
            id: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
          }),
        ],
      },
    });

    expect(plan.boundary).toBe("safe");
    expect(plan.model).toBe("openai/gpt-5.4-mini");
    expect(plan.modelRoute).toEqual({
      selectedModel: "openai/gpt-5.4-mini",
      requestedModel: "openai/gpt-5.4-mini",
      source: "execution_shape",
      mode: "explicit",
      reason: "Explicit executionShape model override.",
    });
    expect(plan.managedToolMode).toBe("direct");
    expect(plan.builtinToolNames).toEqual(["read"]);
    expect(plan.managedToolNames).toEqual([]);
    expect(plan.managedToolNames).not.toContain("subagent_run");
    expect(plan.prompt).toBe("Review and summarize.");
  });

  test("resolveDelegationExecutionPlan rejects consult runs without consultBrief", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-subagent-shared-missing-brief-")),
    });

    expect(() =>
      resolveDelegationExecutionPlan({
        runtime,
        target: makeTarget({
          agentSpecName: "advisor",
          envelopeName: "readonly-advisor",
        }),
        packet: {
          objective: "Review the gateway deltas.",
        },
      }),
    ).toThrow("missing_consult_brief");
  });

  test("resolveDelegationTarget derives a default agent spec from executionShape.resultMode", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        executionShape: {
          resultMode: "qa",
          boundary: "safe",
        },
      },
    });

    expect(resolved.delegate).toBe("qa");
    expect(resolved.target.resultMode).toBe("qa");
  });

  test("resolveDelegationTarget derives consultKind from registered skillName", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        skillName: "discovery",
      },
    });

    expect(resolved.delegate).toBe("advisor");
    expect(resolved.target.agentSpecName).toBe("advisor");
    expect(resolved.target.skillName).toBe("discovery");
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("investigate");
  });

  test("resolveDelegationTarget routes architecture through advisor design consults", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        skillName: "architecture",
      },
    });

    expect(resolved.delegate).toBe("advisor");
    expect(resolved.target.agentSpecName).toBe("advisor");
    expect(resolved.target.skillName).toBe("architecture");
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("design");
  });

  test("resolveDelegationTarget routes office-hours through advisor design consults", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        skillName: "office-hours",
      },
    });

    expect(resolved.delegate).toBe("advisor");
    expect(resolved.target.agentSpecName).toBe("advisor");
    expect(resolved.target.skillName).toBe("office-hours");
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("design");
  });

  test("resolveDelegationTarget materializes a skill-first agent spec through the catalog", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agentSpec: "advisor",
        consultKind: "review",
      },
    });

    expect(resolved.delegate).toBe("advisor");
    expect(resolved.target.agentSpecName).toBe("advisor");
    expect(resolved.target.envelopeName).toBe("readonly-advisor");
    expect(resolved.target.skillName).toBeUndefined();
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("review");
  });

  test("resolveDelegationTarget rejects advisor runs without an explicit consultKind", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agentSpec: "advisor",
        },
      }),
    ).toThrow("missing_consult_kind");
  });

  test("resolveDelegationTarget supports built-in review lane delegates", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const resolved = resolveDelegationTarget({
      catalog,
      request: {
        agentSpec: "review-security",
      },
    });

    expect(resolved.delegate).toBe("review-security");
    expect(resolved.target.agentSpecName).toBe("review-security");
    expect(resolved.target.envelopeName).toBe("readonly-advisor");
    expect(resolved.target.skillName).toBeUndefined();
    expect(resolved.target.resultMode).toBe("consult");
    expect(resolved.target.consultKind).toBe("review");
  });

  test("resolveDelegationTarget rejects envelope-only ad hoc runs", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          envelope: "readonly-advisor",
          consultKind: "investigate",
          executionShape: {
            resultMode: "consult",
          },
        },
      }),
    ).toThrow("envelope_requires_agent_spec");
  });

  test("resolveDelegationTarget fails fast on unknown agent specs even when an envelope is supplied", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agentSpec: "does-not-exist",
          envelope: "readonly-advisor",
        },
      }),
    ).toThrow("unknown_agent_spec:does-not-exist");
  });

  test("resolveDelegationTarget resolves a markdown custom specialist by agent spec name", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-spec-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "security-advisor.md"),
      [
        "---",
        'name: "security-advisor"',
        'description: "Workspace security advisor"',
        'extends: "advisor"',
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
        agentSpec: "security-advisor",
        consultKind: "review",
      },
    });

    expect(resolved.delegate).toBe("security-advisor");
    expect(resolved.target.agentSpecName).toBe("security-advisor");
    expect(resolved.target.envelopeName).toBe("readonly-advisor");
    expect(resolved.target.managedToolNames).toEqual(["grep", "read_spans"]);
  });

  test("resolveDelegationTarget rejects legacy workspace envelope configs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-envelope-narrow-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-advisor.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "tight-advisor",
          extends: "readonly-advisor",
          description: "Narrowed advisor envelope",
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

  test("resolveDelegationTarget rejects request envelopes that widen an agent spec envelope", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(() =>
      resolveDelegationTarget({
        catalog,
        request: {
          agentSpec: "advisor",
          consultKind: "review",
          envelope: "patch-worker",
        },
      }),
    ).toThrow("conflicting_agent_spec_and_envelope:boundary cannot widen beyond the base envelope");
  });
});
