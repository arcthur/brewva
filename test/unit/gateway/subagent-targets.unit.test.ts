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
        name: "explore",
        description: "Read-only scout",
        resultMode: "exploration",
        executorPreamble: "Investigate and summarize.",
        agentSpecName: "explore",
        envelopeName: "readonly-scout",
        producesPatches: false,
        contextProfile: "minimal",
      },
      packet: {
        objective: "Inspect the current architecture",
        contextBudget: {
          maxInjectionTokens: 12,
        },
        contextRefs: [
          {
            kind: "workspace_span",
            locator: "packages/brewva-runtime/src/runtime.ts#L1",
            summary: "Primary runtime surface",
          },
          {
            kind: "workspace_span",
            locator: "packages/brewva-gateway/src/host/create-hosted-session.ts#L1",
            summary: "Hosted session wiring",
          },
        ],
      },
    });

    expect(prompt).toContain("Context References");
    expect(prompt).toContain("[truncated]");
  });

  test("renders active skill and execution hints in the delegated prompt", () => {
    const prompt = buildDelegationPrompt({
      target: {
        name: "review",
        description: "Read-only reviewer",
        resultMode: "review",
        executorPreamble: "Review and summarize.",
        skillName: "review",
        agentSpecName: "review",
        envelopeName: "readonly-reviewer",
        producesPatches: false,
        contextProfile: "minimal",
      },
      packet: {
        objective: "Review the runtime merge path",
        activeSkillName: "review",
        executionHints: {
          preferredTools: ["lsp_diagnostics"],
          fallbackTools: ["grep"],
          preferredSkills: ["review"],
        },
      },
    });

    expect(prompt).toContain("Parent skill: review");
    expect(prompt).toContain("Delegated skill: review");
    expect(prompt).toContain("## Execution Hints");
    expect(prompt).toContain("Preferred tools: lsp_diagnostics");
    expect(prompt).toContain("Preferred skills: review");
  });

  test("injects delegated skill markdown and requires skillOutputs in the structured contract", () => {
    const runtime = createIsolatedRuntime("review");
    const skill = runtime.skills.get("review");
    expect(skill).toBeDefined();

    const prompt = buildDelegationPrompt({
      target: {
        name: "review",
        description: "Read-only reviewer",
        resultMode: "review",
        executorPreamble: "Operate as a strict read-only reviewer.",
        skillName: "review",
        agentSpecName: "review",
        envelopeName: "readonly-reviewer",
        producesPatches: false,
        contextProfile: "minimal",
      },
      packet: {
        objective: "Review the runtime merge path",
      },
      skill: skill!,
    });

    expect(prompt).toContain("## Delegated Skill");
    expect(prompt).toContain("### Skill Body");
    expect(prompt).toContain("Review Skill");
    expect(prompt).toContain("skillOutputs");
    expect(prompt).toContain("Set skillName to review.");
    expect(prompt).toContain(
      "If the lane clears, record disposition=clear instead of inventing findings.",
    );
    expect(prompt).toContain('"lane": "review-correctness"');
    expect(prompt).toContain('"disposition": "concern"');
    expect(prompt).toContain(
      '"primaryClaim": "The replay handoff relies on an unproven invariant."',
    );
    expect(prompt).toContain('"missingEvidence": [');
  });

  test("injects QA anti-rationalization guidance into delegated prompts", () => {
    const runtime = createIsolatedRuntime("qa");
    const skill = runtime.skills.get("qa");
    expect(skill).toBeDefined();

    const prompt = buildDelegationPrompt({
      target: {
        name: "qa",
        description: "Adversarial QA verifier",
        resultMode: "qa",
        executorPreamble: "Operate as an adversarial QA verifier.",
        skillName: "qa",
        agentSpecName: "qa",
        envelopeName: "qa-runner",
        producesPatches: false,
        contextProfile: "minimal",
      },
      packet: {
        objective: "Try to break the delegated change and preserve the evidence.",
      },
      skill: skill!,
    });

    expect(prompt).toContain("Recognize your own rationalizations");
    expect(prompt).toContain("The code looks correct based on my reading.");
    expect(prompt).toContain("Do not invent QA checks from code reading or expectation alone.");
    expect(prompt).toContain("exitCode");
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

  test("rejects workspace subagent files without an explicit kind", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-config-kind-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "explore.json"),
      JSON.stringify(
        {
          name: "explore",
          description: "Missing explicit kind",
          envelope: "readonly-scout",
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
        "invalid_subagent_config:explore.json:missing required kind",
      );
    }
  });

  test("defaults markdown workspace subagent files to agentSpec", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-markdown-kind-"));
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      [
        "---",
        'name: "reviewer"',
        'description: "Markdown-backed reviewer"',
        'envelope: "readonly-reviewer"',
        'skillName: "review"',
        "---",
        "",
        "Operate as a strict reviewer and summarize the highest-risk findings.",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("reviewer")).toEqual(
      expect.objectContaining({
        name: "reviewer",
        description: "Markdown-backed reviewer",
        envelope: "readonly-reviewer",
        skillName: "review",
        instructionsMarkdown:
          "Operate as a strict reviewer and summarize the highest-risk findings.",
      }),
    );
  });
});
