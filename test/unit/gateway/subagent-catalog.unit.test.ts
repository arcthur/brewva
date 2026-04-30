import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostedDelegationCatalog } from "../../../packages/brewva-gateway/src/subagents/catalog.js";

function createWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWorkspaceSubagent(
  workspace: string,
  fileName: string,
  lines: readonly string[],
): void {
  const subagentDir = join(workspace, ".brewva", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(join(subagentDir, fileName), lines.join("\n"), "utf8");
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

describe("subagent delegation catalog", () => {
  test("classifies built-in public specialists and internal review lanes", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(catalog.agentSpecs.get("advisor")).toMatchObject({
      name: "advisor",
      visibility: "public",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
    });
    expect(catalog.agentSpecs.get("qa")).toMatchObject({
      name: "qa",
      visibility: "public",
      envelope: "qa-runner",
      fallbackResultMode: "qa",
    });
    expect(catalog.agentSpecs.get("patch-worker")).toMatchObject({
      name: "patch-worker",
      visibility: "public",
      envelope: "patch-worker",
      fallbackResultMode: "patch",
    });

    for (const agentSpecName of [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-security",
      "review-concurrency",
      "review-compatibility",
      "review-performance",
    ]) {
      expect(catalog.agentSpecs.get(agentSpecName)).toMatchObject({
        name: agentSpecName,
        visibility: "internal",
        envelope: "readonly-advisor",
        fallbackResultMode: "consult",
        defaultConsultKind: "review",
      });
    }
  });

  test("classifies built-in execution envelope isolation strategies", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(catalog.envelopes.get("readonly-advisor")).toMatchObject({
      boundary: "safe",
      isolationStrategy: "shared",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("qa-runner")).toMatchObject({
      boundary: "effectful",
      isolationStrategy: "ephemeral",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("patch-worker")).toMatchObject({
      boundary: "effectful",
      isolationStrategy: "snapshot",
      producesPatches: true,
    });
  });

  test("loads markdown-authored custom specialists from .brewva/subagents", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-md-");
    writeWorkspaceSubagent(workspace, "security-advisor.md", [
      "---",
      'name: "security-advisor"',
      'description: "Workspace security advisor"',
      'extends: "advisor"',
      'tools: ["grep", "read_spans"]',
      'modelPreset: "high-reasoning"',
      'reasoningEffort: "high"',
      "---",
      "",
      "Focus on trust boundaries, credential exposure, and misuse paths.",
      "",
    ]);

    const catalog = await loadHostedDelegationCatalog(workspace);

    expect(catalog.agentSpecs.get("security-advisor")).toEqual({
      name: "security-advisor",
      description: "Workspace security advisor",
      visibility: "public",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
      modelPreset: "high-reasoning",
      reasoningEffort: "high",
      managedToolNames: ["grep", "read_spans"],
      executorPreamble:
        "Operate as a read-only advisor. Reduce uncertainty, keep evidence concrete, and optimize for the parent's next decision.",
      instructionsMarkdown: "Focus on trust boundaries, credential exposure, and misuse paths.",
    });
    expect(catalog.workspaceAgentSpecNames.has("security-advisor")).toBe(true);
    expect(catalog.workspaceEnvelopeNames.size).toBe(0);
  });

  test("rejects custom specialist tools outside the base envelope", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-wide-tools-");
    writeWorkspaceSubagent(workspace, "unsafe-advisor.md", [
      "---",
      'name: "unsafe-advisor"',
      'description: "Invalid write-capable advisor"',
      'extends: "advisor"',
      'tools: ["grep", "exec"]',
      "---",
      "Try to execute commands.",
    ]);

    await expectCatalogLoadToReject(
      workspace,
      "invalid_agent_spec:unsafe-advisor:managedToolNames widens the base envelope with exec",
    );
  });

  test("rejects forbidden custom specialist frontmatter fields", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-forbidden-");
    writeWorkspaceSubagent(workspace, "lane.md", [
      "---",
      'name: "lane"',
      'description: "Invalid review lane declaration"',
      'extends: "advisor"',
      'reviewLane: "review-security"',
      "---",
      "Do not load.",
    ]);

    await expectCatalogLoadToReject(
      workspace,
      "workspace agent spec fields are not supported: reviewLane",
    );
  });

  test("rejects custom specialists that do not narrow a public built-in", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-bad-extends-");
    writeWorkspaceSubagent(workspace, "review-security-wrapper.md", [
      "---",
      'name: "review-security-wrapper"',
      'description: "Invalid internal base"',
      'extends: "review-security"',
      "---",
      "Do not load.",
    ]);

    await expectCatalogLoadToReject(
      workspace,
      "invalid_agent_spec:review-security-wrapper.md:extends must be advisor, qa, or patch-worker",
    );
  });

  test("rejects workspace execution envelopes and JSON configs", async () => {
    const workspace = createWorkspace("brewva-subagent-json-hard-fail-");
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-advisor.json"),
      JSON.stringify({
        kind: "envelope",
        name: "tight-advisor",
        extends: "readonly-advisor",
      }),
      "utf8",
    );
    writeFileSync(
      join(subagentDir, "wide-qa.json"),
      JSON.stringify({
        kind: "envelope",
        name: "wide-qa",
        extends: "qa-runner",
      }),
      "utf8",
    );

    await expectCatalogLoadToReject(
      workspace,
      "invalid_subagent_config:[tight-advisor.json,wide-qa.json]:JSON subagent configs are no longer supported",
    );
  });

  test("rejects legacy markdown subagent config directories", async () => {
    const workspace = createWorkspace("brewva-subagent-legacy-agents-hard-fail-");
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "advisor.md"),
      ["---", "extends: advisor", "---", "Legacy location."].join("\n"),
      "utf8",
    );

    await expectCatalogLoadToReject(
      workspace,
      "legacy .brewva/agents subagent configs are no longer supported",
    );
  });
});
