import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDelegationPrompt,
  buildHostedDelegationTargetFromAgentSpec,
  loadHostedDelegationCatalog,
} from "@brewva/brewva-gateway";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";

function createIsolatedRuntime(name: string): BrewvaHostedRuntimePort {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-subagent-runtime-${name}-`));
  return createBrewvaRuntime({ cwd: workspace }).hosted;
}

describe("delegation prompt and catalog composition", () => {
  test("truncates context references when prompt injection budget is small", () => {
    const prompt = buildDelegationPrompt({
      target: {
        name: "explorer",
        agent: "explorer",
        targetName: "explorer",
        description: "Read-only explorer",
        visibility: "public",
        resultMode: "consult",
        consultKind: "investigate",
        modelCategory: "deep-reasoning",
        gateReason: "make_judgment",
        executorPreamble: "Investigate and summarize.",
        agentSpecName: "explorer",
        envelopeName: "explorer-readonly",
        producesPatches: false,
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
    expect(prompt).toContain("Delegation gate reason: make_judgment");
    expect(prompt).toContain("[truncated]");
  });

  test("renders execution hints without parent skill state in the delegated prompt", () => {
    const prompt = buildDelegationPrompt({
      target: {
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
        agentSpecName: "explorer",
        envelopeName: "explorer-readonly",
        producesPatches: false,
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
    const skill = requireDefined(
      runtime.inspect.skills.catalog.get("review"),
      "Expected review skill in hosted runtime catalog.",
    );

    const prompt = buildDelegationPrompt({
      target: {
        name: "explorer",
        agent: "explorer",
        targetName: "explorer",
        description: "Read-only explorer",
        visibility: "public",
        resultMode: "consult",
        consultKind: "review",
        modelCategory: "deep-reasoning",
        gateReason: "make_judgment",
        executorPreamble: "Operate as a strict read-only explorer.",
        agentSpecName: "explorer",
        envelopeName: "explorer-readonly",
        producesPatches: false,
        isolationStrategy: "shared",
      },
      packet: {
        objective: "Review the runtime merge path",
        consultBrief: {
          decision: "Should the parent accept the runtime merge path?",
          successCriteria: "Return a review judgment with evidence and next steps.",
        },
      },
      skill,
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

  test("injects Verifier anti-rationalization guidance into delegated prompts", () => {
    const runtime = createIsolatedRuntime("verifier");
    const skill = requireDefined(
      runtime.inspect.skills.catalog.get("verifier"),
      "Expected Verifier skill in hosted runtime catalog.",
    );

    const prompt = buildDelegationPrompt({
      target: {
        name: "verifier",
        agent: "verifier",
        targetName: "verifier",
        description: "Adversarial verifier",
        visibility: "public",
        resultMode: "verifier",
        modelCategory: "verification",
        gateReason: "verify_reproducibly",
        executorPreamble: "Operate as an adversarial verifier.",
        skillName: "verifier",
        agentSpecName: "verifier",
        envelopeName: "verifier-runner",
        producesPatches: false,
        isolationStrategy: "ephemeral",
      },
      packet: {
        objective: "Try to break the delegated change and preserve the evidence.",
      },
      skill,
    });

    expect(prompt).toContain("Recognize your own rationalizations");
    expect(prompt).toContain("The code looks correct based on my reading.");
    expect(prompt).toContain(
      "Do not invent verifier checks from code reading or expectation alone.",
    );
    expect(prompt).toContain("exit_code");
  });

  test("materializes the built-in worker through the catalog", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const agentSpec = requireDefined(
      catalog.agentSpecs.get("worker"),
      "Expected built-in worker agent spec.",
    );
    const envelope = requireDefined(
      catalog.envelopes.get("worker"),
      "Expected built-in worker envelope.",
    );

    const target = buildHostedDelegationTargetFromAgentSpec({
      agentSpec,
      envelope,
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
          name: "explorer",
          description: "Missing explicit kind",
          envelope: "explorer-readonly",
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
        'description: "Markdown-backed explorer"',
        'extends: "explorer"',
        "---",
        "",
        "Operate as a strict explorer and summarize the highest-risk findings.",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("reviewer")).toEqual(
      expect.objectContaining({
        name: "reviewer",
        description: "Markdown-backed explorer",
        visibility: "public",
        envelope: "explorer-readonly",
        fallbackResultMode: "consult",
        instructionsMarkdown:
          "Operate as a strict explorer and summarize the highest-risk findings.",
      }),
    );
  });
});
