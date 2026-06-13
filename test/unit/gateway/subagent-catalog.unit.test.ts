import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATION_ENVELOPE_ARCHETYPES,
  deriveDelegationAdoptionRequirement,
} from "@brewva/brewva-vocabulary/delegation";
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
      envelope: "readonly-shared",
      fallbackResultMode: "evidence",
    });
    expect(catalog.agentSpecs.get("explorer")).toMatchObject({
      name: "explorer",
      visibility: "public",
      envelope: "readonly-shared",
      fallbackResultMode: "consult",
    });
    expect(catalog.agentSpecs.get("verifier")).toMatchObject({
      name: "verifier",
      visibility: "public",
      envelope: "exec-ephemeral",
      fallbackResultMode: "verifier",
    });
    expect(catalog.agentSpecs.get("worker")).toMatchObject({
      name: "worker",
      visibility: "public",
      envelope: "patch-snapshot",
      fallbackResultMode: "patch",
    });
    expect(catalog.agentSpecs.get("librarian")).toMatchObject({
      name: "librarian",
      visibility: "public",
      envelope: "readonly-shared",
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
        envelope: "readonly-shared",
        fallbackResultMode: "consult",
        defaultConsultKind: "review",
      });
    }
  });

  test("exposes exactly the three execution archetypes with their physics", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect([...catalog.envelopes.keys()].toSorted()).toEqual([
      "exec-ephemeral",
      "patch-snapshot",
      "readonly-shared",
    ]);
    expect(catalog.envelopes.get("readonly-shared")).toMatchObject({
      name: "readonly-shared",
      boundary: "safe",
      isolationStrategy: "shared",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("exec-ephemeral")).toMatchObject({
      name: "exec-ephemeral",
      boundary: "effectful",
      isolationStrategy: "ephemeral_exec",
      producesPatches: false,
    });
    expect(catalog.envelopes.get("patch-snapshot")).toMatchObject({
      name: "patch-snapshot",
      boundary: "effectful",
      isolationStrategy: "snapshot",
      producesPatches: true,
    });
  });

  test("keeps read-only capsule tool sets capability-distinct within one archetype", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    // Tool distinctness now lives on the capsule, not the archetype. All three
    // read-only personas share the readonly-shared archetype but narrow it to
    // their own subset.
    const navigatorTools = catalog.agentSpecs.get("navigator")?.managedToolNames ?? [];
    const explorerTools = catalog.agentSpecs.get("explorer")?.managedToolNames ?? [];
    const librarianTools = catalog.agentSpecs.get("librarian")?.managedToolNames ?? [];
    const readonlyCeiling = catalog.envelopes.get("readonly-shared")?.managedToolNames ?? [];

    expect(catalog.agentSpecs.get("navigator")?.envelope).toBe("readonly-shared");
    expect(catalog.agentSpecs.get("explorer")?.envelope).toBe("readonly-shared");
    expect(catalog.agentSpecs.get("librarian")?.envelope).toBe("readonly-shared");

    expect(navigatorTools).toEqual(expect.arrayContaining(["grep", "source_read", "code_digest"]));
    expect(navigatorTools).not.toContain("knowledge_search");
    expect(navigatorTools).not.toContain("recall_search");
    expect(navigatorTools).not.toContain("workflow_status");

    expect(explorerTools).toEqual(
      expect.arrayContaining(["grep", "ledger_query", "task_view_state", "workflow_status"]),
    );
    expect(explorerTools).not.toContain("knowledge_search");
    expect(explorerTools).not.toContain("recall_search");

    expect(librarianTools).toEqual(
      expect.arrayContaining(["knowledge_search", "recall_search", "precedent_sweep"]),
    );
    expect(librarianTools).not.toContain("grep");
    expect(librarianTools).not.toContain("workflow_status");

    // The archetype ceiling is the union: every capsule's tools are a subset.
    const ceiling = new Set(readonlyCeiling);
    for (const tools of [navigatorTools, explorerTools, librarianTools]) {
      for (const tool of tools) {
        expect(ceiling.has(tool)).toBe(true);
      }
    }
    expect(readonlyCeiling).toEqual(
      expect.arrayContaining(["grep", "workflow_status", "knowledge_search", "recall_search"]),
    );
  });

  test("binds adoption to the result contract, orthogonal to the archetype", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    const adoptionFor = (capsuleName: string) => {
      const capsule = catalog.agentSpecs.get(capsuleName);
      return deriveDelegationAdoptionRequirement(capsule?.fallbackResultMode ?? "consult");
    };

    // Read-only and verifier personas carry no adoption obligation.
    expect(adoptionFor("navigator")).toBe("none");
    expect(adoptionFor("explorer")).toBe("none");
    expect(adoptionFor("verifier")).toBe("none");

    // Worker (patch) requires patch adoption and runs on the only patch-producing archetype.
    expect(adoptionFor("worker")).toBe("patch_apply");
    expect(catalog.envelopes.get(catalog.agentSpecs.get("worker")!.envelope)?.producesPatches).toBe(
      true,
    );

    // Librarian proves orthogonality: a knowledge result still demands explicit
    // adoption even though it runs on the read-only, non-patch archetype.
    expect(adoptionFor("librarian")).toBe("knowledge_adopt");
    expect(catalog.agentSpecs.get("librarian")?.envelope).toBe("readonly-shared");
    expect(
      catalog.envelopes.get(catalog.agentSpecs.get("librarian")!.envelope)?.producesPatches,
    ).toBe(false);

    // Only the three archetypes exist, and every capsule binds one of them.
    expect([...catalog.envelopes.keys()].toSorted()).toEqual(
      [...DELEGATION_ENVELOPE_ARCHETYPES].toSorted(),
    );
    const archetypeNames = DELEGATION_ENVELOPE_ARCHETYPES as readonly string[];
    for (const capsule of catalog.agentSpecs.values()) {
      expect(archetypeNames).toContain(capsule.envelope);
    }
  });

  test("loads markdown-authored custom specialists from .brewva/subagents", async () => {
    const workspace = createWorkspace("brewva-subagent-custom-md-");
    writeWorkspaceSubagent(workspace, "security-explorer.md", [
      "---",
      'name: "security-explorer"',
      'description: "Workspace security explorer"',
      'extends: "explorer"',
      'tools: ["grep", "source_read"]',
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
      envelope: "readonly-shared",
      gateReason: "make_judgment",
      modelCategory: "deep-reasoning",
      fallbackResultMode: "consult",
      modelPreset: "high-reasoning",
      reasoningEffort: "high",
      managedToolNames: ["grep", "source_read"],
      executorPreamble:
        "Operate as an explorer. Use evidence to make a bounded judgment, preserve counterevidence, and recommend the parent's next decision.",
      instructionsMarkdown: "Focus on trust boundaries, credential exposure, and misuse paths.",
    });
    expect(catalog.workspaceAgentSpecNames.has("security-explorer")).toBe(true);
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

  test("rejects a workspace capsule acquiring a sibling persona's tool from the shared archetype", async () => {
    // knowledge_search lives in the readonly-shared archetype ceiling (librarian
    // uses it) but not in the explorer persona. A workspace explorer must narrow
    // the explorer persona, not the shared archetype ceiling, so this is rejected.
    const workspace = createWorkspace("brewva-subagent-sibling-tool-");
    writeWorkspaceSubagent(workspace, "nosy-explorer.md", [
      "---",
      'name: "nosy-explorer"',
      'description: "Explorer reaching for librarian recall tools"',
      'extends: "explorer"',
      'tools: ["grep", "knowledge_search"]',
      "---",
      "Should not load.",
    ]);

    await expectCatalogLoadToReject(
      workspace,
      "invalid_agent_spec:nosy-explorer:managedToolNames widens the base envelope with knowledge_search",
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
