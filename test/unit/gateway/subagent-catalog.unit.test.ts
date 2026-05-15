import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostedDelegationCatalog } from "../../../packages/brewva-gateway/src/delegation/catalog/registry.js";

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

    expect(
      [...catalog.agentSpecs.values()]
        .filter((agentSpec) => agentSpec.visibility === "public")
        .map((agentSpec) => agentSpec.name)
        .toSorted(),
    ).toEqual(["explorer", "librarian", "navigator", "verifier", "worker"]);
    expect(catalog.agentSpecs.get("navigator")).toMatchObject({
      name: "navigator",
      visibility: "public",
      envelope: "navigator-readonly",
      fallbackResultMode: "evidence",
    });
    expect(catalog.agentSpecs.get("explorer")).toMatchObject({
      name: "explorer",
      visibility: "public",
      envelope: "explorer-readonly",
      fallbackResultMode: "consult",
    });
    expect(catalog.agentSpecs.get("verifier")).toMatchObject({
      name: "verifier",
      visibility: "public",
      envelope: "verifier-runner",
      fallbackResultMode: "verifier",
    });
    expect(catalog.agentSpecs.get("worker")).toMatchObject({
      name: "worker",
      visibility: "public",
      envelope: "worker",
      fallbackResultMode: "patch",
    });
    expect(catalog.agentSpecs.get("librarian")).toMatchObject({
      name: "librarian",
      visibility: "public",
      envelope: "librarian-readonly",
      fallbackResultMode: "knowledge",
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
        envelope: "explorer-readonly",
        fallbackResultMode: "consult",
        defaultConsultKind: "review",
      });
    }
  });

  test("classifies built-in execution envelope isolation strategies", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(catalog.envelopes.get("explorer-readonly")).toMatchObject({
      boundary: "safe",
      isolationStrategy: "shared",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("verifier-runner")).toMatchObject({
      boundary: "effectful",
      isolationStrategy: "ephemeral",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("worker")).toMatchObject({
      boundary: "effectful",
      isolationStrategy: "snapshot",
      producesPatches: true,
    });
  });

  test("keeps read-only role tool sets capability-distinct", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    const navigatorTools = catalog.envelopes.get("navigator-readonly")?.managedToolNames ?? [];
    const explorerTools = catalog.envelopes.get("explorer-readonly")?.managedToolNames ?? [];
    const librarianTools = catalog.envelopes.get("librarian-readonly")?.managedToolNames ?? [];
    const verifierTools = catalog.envelopes.get("verifier-runner")?.managedToolNames ?? [];
    const workerTools = catalog.envelopes.get("worker")?.managedToolNames ?? [];

    expect(navigatorTools).toEqual(expect.arrayContaining(["grep", "read_spans", "toc_search"]));
    expect(navigatorTools).toContain("agent_send");
    expect(navigatorTools).not.toContain("knowledge_search");
    expect(navigatorTools).not.toContain("recall_search");
    expect(navigatorTools).not.toContain("workflow_status");

    expect(explorerTools).toEqual(
      expect.arrayContaining(["grep", "ledger_query", "task_view_state", "workflow_status"]),
    );
    expect(explorerTools).toContain("agent_send");
    expect(explorerTools).not.toContain("knowledge_search");
    expect(explorerTools).not.toContain("recall_search");

    expect(librarianTools).toEqual(
      expect.arrayContaining(["knowledge_search", "recall_search", "precedent_sweep"]),
    );
    expect(librarianTools).toContain("agent_send");
    expect(librarianTools).not.toContain("grep");
    expect(librarianTools).not.toContain("workflow_status");

    expect(verifierTools).not.toContain("agent_send");
    expect(workerTools).not.toContain("agent_send");
  });

  test("loads markdown-authored custom specialists from .brewva/subagents", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-md-");
    writeWorkspaceSubagent(workspace, "security-explorer.md", [
      "---",
      'name: "security-explorer"',
      'description: "Workspace security explorer"',
      'extends: "explorer"',
      'tools: ["grep", "read_spans"]',
      'modelPreset: "high-reasoning"',
      'reasoningEffort: "high"',
      "---",
      "",
      "Focus on trust boundaries, credential exposure, and misuse paths.",
      "",
    ]);

    const catalog = await loadHostedDelegationCatalog(workspace);

    expect(catalog.agentSpecs.get("security-explorer")).toMatchObject({
      name: "security-explorer",
      agent: "explorer",
      description: "Workspace security explorer",
      visibility: "public",
      envelope: "explorer-readonly",
      gateReason: "make_judgment",
      modelCategory: "deep-reasoning",
      fallbackResultMode: "consult",
      modelPreset: "high-reasoning",
      reasoningEffort: "high",
      managedToolNames: ["grep", "read_spans"],
      executorPreamble:
        "Operate as an explorer. Use evidence to make a bounded judgment, preserve counterevidence, and recommend the parent's next decision.",
      instructionsMarkdown: "Focus on trust boundaries, credential exposure, and misuse paths.",
    });
    expect(catalog.workspaceAgentSpecNames.has("security-explorer")).toBe(true);
    expect(catalog.workspaceEnvelopeNames.size).toBe(0);
  });

  test("rejects custom specialist tools outside the base envelope", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-wide-tools-");
    writeWorkspaceSubagent(workspace, "unsafe-explorer.md", [
      "---",
      'name: "unsafe-explorer"',
      'description: "Invalid write-capable explorer"',
      'extends: "explorer"',
      'tools: ["grep", "exec"]',
      "---",
      "Try to execute commands.",
    ]);

    await expectCatalogLoadToReject(
      workspace,
      "invalid_agent_spec:unsafe-explorer:managedToolNames widens the base envelope with exec",
    );
  });

  test("rejects forbidden custom specialist frontmatter fields", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-forbidden-");
    writeWorkspaceSubagent(workspace, "lane.md", [
      "---",
      'name: "lane"',
      'description: "Invalid review lane declaration"',
      'extends: "explorer"',
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
      "invalid_agent_spec:review-security-wrapper.md:extends must be navigator, explorer, worker, verifier, or librarian",
    );
  });

  test("rejects workspace execution envelopes and JSON configs", async () => {
    const workspace = createWorkspace("brewva-subagent-json-hard-fail-");
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-explorer.json"),
      JSON.stringify({
        kind: "envelope",
        name: "tight-explorer",
        extends: "explorer-readonly",
      }),
      "utf8",
    );
    writeFileSync(
      join(subagentDir, "wide-verifier.json"),
      JSON.stringify({
        kind: "envelope",
        name: "wide-verifier",
        extends: "verifier-runner",
      }),
      "utf8",
    );

    await expectCatalogLoadToReject(
      workspace,
      "invalid_subagent_config:[tight-explorer.json,wide-verifier.json]:JSON subagent configs are no longer supported",
    );
  });

  test("rejects legacy markdown subagent config directories", async () => {
    const workspace = createWorkspace("brewva-subagent-legacy-agents-hard-fail-");
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "explorer.md"),
      ["---", "extends: explorer", "---", "Legacy location."].join("\n"),
      "utf8",
    );

    await expectCatalogLoadToReject(
      workspace,
      "legacy .brewva/agents subagent configs are no longer supported",
    );
  });
});
