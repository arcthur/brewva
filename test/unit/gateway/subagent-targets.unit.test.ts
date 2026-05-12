import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDelegationPrompt,
  buildHostedDelegationTargetFromAgentSpec,
  loadHostedDelegationCatalog,
} from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createIsolatedRuntime(name: string): BrewvaRuntime {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-subagent-runtime-${name}-`));
  return new BrewvaRuntime({ cwd: workspace });
}

describe("delegation prompt and catalog composition", () => {
  test("truncates context references when prompt injection budget is small", () => {
    const prompt = buildDelegationPrompt({
      target: {
        name: "advisor",
        description: "Read-only advisor",
        visibility: "public",
        resultMode: "consult",
        consultKind: "investigate",
        executorPreamble: "Investigate and summarize.",
        agentSpecName: "advisor",
        envelopeName: "readonly-advisor",
        producesPatches: false,
        contextProfile: "minimal",
        isolationStrategy: "shared",
      },
      packet: {
        objective: "Inspect the current architecture",
        contextBudget: {
          maxInjectionTokens: 12,
        },
        contextRefs: [
          {
            kind: "workspace_span",
            locator: "packages/brewva-runtime/src/runtime/runtime.ts#L1",
            summary: "Primary runtime surface",
          },
          {
            kind: "workspace_span",
            locator: "packages/brewva-gateway/src/hosted/api.ts#L1",
            summary: "Hosted session wiring",
          },
        ],
      },
    });

    expect(prompt).toContain("Context References");
    expect(prompt).toContain("[truncated]");
  });

  test("renders execution hints without parent skill state in the delegated prompt", () => {
    const prompt = buildDelegationPrompt({
      target: {
        name: "advisor",
        description: "Read-only advisor",
        visibility: "public",
        resultMode: "consult",
        consultKind: "review",
        executorPreamble: "Review and summarize.",
        agentSpecName: "advisor",
        envelopeName: "readonly-advisor",
        producesPatches: false,
        contextProfile: "minimal",
        isolationStrategy: "shared",
      },
      packet: {
        objective: "Review the runtime merge path",
        executionHints: {
          preferredTools: ["lsp_diagnostics"],
          fallbackTools: ["grep"],
        },
      },
    });

    expect(prompt).toContain("Consult kind: review");
    expect(prompt).toContain("## Execution Hints");
    expect(prompt).toContain("Preferred tools: lsp_diagnostics");
    expect(prompt).not.toContain("Parent skill:");
    expect(prompt).not.toContain("Preferred skills:");
  });

  test("injects semantic skill markdown for consult runs without requiring skillOutputs", () => {
    const runtime = createIsolatedRuntime("review");
    const skill = runtime.inspect.skills.get("review");
    expect(skill).toBeDefined();

    const prompt = buildDelegationPrompt({
      target: {
        name: "advisor",
        description: "Read-only advisor",
        visibility: "public",
        resultMode: "consult",
        consultKind: "review",
        executorPreamble: "Operate as a strict read-only advisor.",
        agentSpecName: "advisor",
        envelopeName: "readonly-advisor",
        producesPatches: false,
        contextProfile: "minimal",
        isolationStrategy: "shared",
      },
      packet: {
        objective: "Review the runtime merge path",
        consultBrief: {
          decision: "Should the parent accept the runtime merge path?",
          successCriteria: "Return a review judgment with evidence and next steps.",
        },
      },
      skill: skill!,
    });

    expect(prompt).toContain("## Semantic Context");
    expect(prompt).toContain("### Skill Body");
    expect(prompt).toContain("Review Skill");
    expect(prompt).not.toContain("skillOutputs");
    expect(prompt).toContain('"kind": "consult"');
    expect(prompt).toContain('"consultKind": "review"');
    expect(prompt).toContain(
      "If the lane clears, record disposition=clear instead of inventing findings.",
    );
    expect(prompt).toContain('"lane": "review-correctness"');
    expect(prompt).toContain('"disposition": "concern"');
    expect(prompt).toContain(
      '"primaryClaim": "The cutover still leaves one legacy replay branch reachable."',
    );
    expect(prompt).toContain('"missingEvidence": [');
    expect(prompt).toContain('"followUpQuestions": [');
    expect(prompt).toContain("include questionRequests as an array of structured requests");
  });

  test("injects QA anti-rationalization guidance into delegated prompts", () => {
    const runtime = createIsolatedRuntime("qa");
    const skill = runtime.inspect.skills.get("qa");
    expect(skill).toBeDefined();

    const prompt = buildDelegationPrompt({
      target: {
        name: "qa",
        description: "Adversarial QA verifier",
        visibility: "public",
        resultMode: "qa",
        executorPreamble: "Operate as an adversarial QA verifier.",
        skillName: "qa",
        agentSpecName: "qa",
        envelopeName: "qa-runner",
        producesPatches: false,
        contextProfile: "minimal",
        isolationStrategy: "ephemeral",
      },
      packet: {
        objective: "Try to break the delegated change and preserve the evidence.",
      },
      skill: skill!,
    });

    expect(prompt).toContain("Recognize your own rationalizations");
    expect(prompt).toContain("The code looks correct based on my reading.");
    expect(prompt).toContain("Do not invent QA checks from code reading or expectation alone.");
    expect(prompt).toContain("exit_code");
  });

  test("materializes the built-in patch worker through the catalog", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const agentSpec = catalog.agentSpecs.get("patch-worker");
    const envelope = catalog.envelopes.get("patch-worker");
    expect(agentSpec).toBeDefined();
    expect(envelope).toBeDefined();

    const target = buildHostedDelegationTargetFromAgentSpec({
      agentSpec: agentSpec!,
      envelope: envelope!,
    });
    expect(target.resultMode).toBe("patch");
    expect(target.boundary).toBe("effectful");
    expect(target.builtinToolNames).toEqual(["read", "edit", "write"]);
  });

  test("rejects JSON workspace subagent files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-config-kind-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "explore.json"),
      JSON.stringify(
        {
          name: "advisor",
          description: "Missing explicit kind",
          envelope: "readonly-advisor",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_subagent_config:[explore.json]:JSON subagent configs are no longer supported",
      );
    }
  });

  test("loads markdown workspace custom specialists from .brewva/subagents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-markdown-kind-"));
    const agentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      [
        "---",
        'name: "reviewer"',
        'description: "Markdown-backed advisor"',
        'extends: "advisor"',
        "---",
        "",
        "Operate as a strict advisor and summarize the highest-risk findings.",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("reviewer")).toEqual(
      expect.objectContaining({
        name: "reviewer",
        description: "Markdown-backed advisor",
        visibility: "public",
        envelope: "readonly-advisor",
        fallbackResultMode: "consult",
        instructionsMarkdown:
          "Operate as a strict advisor and summarize the highest-risk findings.",
      }),
    );
  });
});
