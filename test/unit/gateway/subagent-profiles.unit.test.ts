import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDelegationPrompt, loadHostedSubagentProfiles } from "@brewva/brewva-gateway";

describe("subagent profiles", () => {
  test("loads workspace overrides on top of built-in profiles", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-profile-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "researcher.json"),
      JSON.stringify(
        {
          extends: "researcher",
          name: "researcher",
          description: "Workspace-specific scout",
          model: "openai/gpt-5.4-mini",
          prompt: "Inspect only the explicitly delegated files and return a terse summary.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const profiles = await loadHostedSubagentProfiles(workspace);
    const profile = profiles.get("researcher");
    expect(profile).toBeDefined();
    expect(profile?.description).toBe("Workspace-specific scout");
    expect(profile?.model).toBe("openai/gpt-5.4-mini");
    expect(profile?.managedToolNames?.includes("grep")).toBe(true);
  });

  test("truncates context references when prompt injection budget is small", () => {
    const prompt = buildDelegationPrompt(
      {
        name: "researcher",
        description: "Read-only scout",
        resultMode: "exploration",
        prompt: "Investigate and summarize.",
      },
      {
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
    );

    expect(prompt).toContain("Context References");
    expect(prompt).toContain("[truncated]");
  });

  test("renders active skill, required outputs, and execution hints in the delegated prompt", () => {
    const prompt = buildDelegationPrompt(
      {
        name: "reviewer",
        description: "Read-only reviewer",
        resultMode: "review",
        prompt: "Review and summarize.",
      },
      {
        objective: "Review the runtime merge path",
        activeSkillName: "review",
        requiredOutputs: ["findings", "verification_evidence"],
        executionHints: {
          preferredTools: ["lsp_diagnostics"],
          fallbackTools: ["grep"],
          preferredSkills: ["review"],
        },
      },
    );

    expect(prompt).toContain("Parent skill: review");
    expect(prompt).toContain("Required outputs: findings, verification_evidence");
    expect(prompt).toContain("## Execution Hints");
    expect(prompt).toContain("Preferred tools: lsp_diagnostics");
    expect(prompt).toContain("Preferred skills: review");
  });

  test("includes a built-in patch worker profile for isolated mutate runs", async () => {
    const profiles = await loadHostedSubagentProfiles(process.cwd());
    const profile = profiles.get("patch-worker");
    expect(profile).toBeDefined();
    expect(profile?.resultMode).toBe("patch");
    expect(profile?.posture).toBe("reversible_mutate");
    expect(profile?.builtinToolNames).toEqual(["read", "edit", "write"]);
  });

  test("rejects same-name overlays that widen the base profile posture or tool surface", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-profile-widen-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "researcher.json"),
      JSON.stringify(
        {
          name: "researcher",
          description: "Widened scout",
          resultMode: "exploration",
          prompt: "Inspect broadly.",
          posture: "reversible_mutate",
          builtinToolNames: ["read", "edit"],
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedSubagentProfiles(workspace);
      throw new Error("expected loadHostedSubagentProfiles to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_subagent_profile:researcher:posture cannot widen beyond the base profile",
      );
    }
  });
});
