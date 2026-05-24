import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  DelegationRunRecord,
  SourcePatchPlan,
  SourceSnapshot,
} from "@brewva/brewva-runtime/protocol";
import { sha256Hex, shortSha256Hex } from "@brewva/brewva-std/hash";
import {
  createResourceReadTool,
  createSourcePatchTools,
  createSourceReadTool,
  type SourceReadToolDetails,
} from "@brewva/brewva-tools/navigation";
import { createWorkerResultsApplyTool } from "@brewva/brewva-tools/workflow";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function requireAnchor(details: SourceReadToolDetails, line: number): string {
  const anchor = details.snapshot.anchors.find((candidate) => candidate.line === line);
  if (!anchor) {
    throw new Error(`Missing anchor for line ${line}`);
  }
  return `L${anchor.line}@${anchor.token}`;
}

function manualSnapshot(input: {
  readonly id: string;
  readonly uri: string;
  readonly path: string;
  readonly text: string;
}): SourceSnapshot {
  const lines = input.text.endsWith("\n")
    ? input.text.slice(0, -1).split("\n")
    : input.text.split("\n");
  return {
    id: input.id,
    uri: input.uri,
    path: input.path,
    contentHash: `sha256:${sha256Hex(input.text)}`,
    createdAt: 1,
    lineCount: lines.length,
    anchors: lines.map((text, index) => {
      const line = index + 1;
      const hash = `sha256:${sha256Hex(text)}`;
      return {
        line,
        token: shortSha256Hex(`${line}:${hash}`, 6),
        hash,
        text,
      };
    }),
  };
}

describe("source_read and source_patch tools", () => {
  test("source_read emits hash-anchored editable lines", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-read-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "export const alpha = 1;\nexport const beta = 2;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const tool = createSourceReadTool({ runtime });

    const result = await tool.execute(
      "tc-source-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: 1, end_line: 2 }],
      },
      undefined,
      undefined,
      fakeContext("tc-source-read"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: SourceReadToolDetails }).details;
    expect(text).toContain("[SourceRead]");
    expect(text).toMatch(/snapshot_id: snap_/u);
    expect(text).toMatch(/L1@[A-Za-z0-9_-]{6}\|export const alpha = 1;/u);
    expect(details?.resourceUri).toBe("brewva-resource:///file/example.ts");
    expect(details?.snapshot.anchors).toHaveLength(2);
  });

  test("source_read accepts file URLs without losing absolute path semantics", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-read-file-url-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "export const alpha = 1;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const tool = createSourceReadTool({ runtime });

    const result = await tool.execute(
      "tc-source-read-file-url",
      {
        uri: pathToFileURL(filePath).toString(),
        mode: "spans",
        spans: [{ start_line: 1, end_line: 1 }],
      },
      undefined,
      undefined,
      fakeContext("tc-source-read-file-url"),
    );

    const details = (result as { details?: SourceReadToolDetails }).details;
    expect(details?.resourceUri).toBe("brewva-resource:///file/example.ts");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("L1@");
  });

  test("source_patch_prepare and source_patch_apply are the only source mutation path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "export const alpha = 1;\nexport const beta = 2;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sourceRead = createSourceReadTool({ runtime });
    const [prepare, apply] = createSourcePatchTools({ runtime });

    const readResult = await sourceRead.execute(
      "tc-source-patch-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: 2, end_line: 2 }],
      },
      undefined,
      undefined,
      fakeContext("tc-source-patch"),
    );
    const readDetails = (readResult as { details?: SourceReadToolDetails }).details;
    if (!readDetails) {
      throw new Error("Missing source_read details.");
    }

    const prepareResult = await prepare.execute(
      "tc-source-patch-prepare",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri: readDetails.resourceUri,
            snapshot_id: readDetails.snapshot.id,
            start_anchor: requireAnchor(readDetails, 2),
            replacement: "export const beta = 20;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-source-patch"),
    );

    const prepareText = extractTextContent(
      prepareResult as { content: Array<{ type: string; text?: string }> },
    );
    const prepareDetails = (prepareResult as { details?: { planId?: string } }).details;
    expect(prepareText).toContain("[SourcePatchPlan]");
    expect(prepareText).toContain("-export const beta = 2;");
    expect(prepareText).toContain("+export const beta = 20;");
    expect(prepareDetails?.planId).toMatch(/^plan_/u);
    expect(readFileSync(filePath, "utf8")).toContain("export const beta = 2;");

    const applyResult = await apply.execute(
      "tc-source-patch-apply",
      {
        plan_id: prepareDetails?.planId,
      },
      undefined,
      undefined,
      fakeContext("tc-source-patch"),
    );

    expect(
      extractTextContent(applyResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("[SourcePatchApply]");
    const applyDetails = (
      applyResult as {
        details?: { patchSet?: { rollbackArtifactRef?: string } | null };
      }
    ).details;
    const rollbackArtifactRef = applyDetails?.patchSet?.rollbackArtifactRef;
    expect(rollbackArtifactRef).toMatch(/^tc-source-patch\/patch_/u);
    const rollbackManifestPath = join(workspace, rollbackArtifactRef ?? "");
    expect(existsSync(rollbackManifestPath)).toBe(true);
    const rollbackManifest = JSON.parse(readFileSync(rollbackManifestPath, "utf8")) as {
      readonly entries?: Array<{ readonly beforeArtifactRef?: string }>;
    };
    const beforeArtifactRef = rollbackManifest.entries?.[0]?.beforeArtifactRef;
    expect(typeof beforeArtifactRef).toBe("string");
    expect(readFileSync(join(workspace, beforeArtifactRef ?? ""), "utf8")).toContain(
      "export const beta = 2;",
    );
    expect(readFileSync(filePath, "utf8")).toContain("export const beta = 20;");
  });

  test("source_patch_prepare preview preserves intentional blank lines", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-preview-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "export const alpha = 1;\n\nexport const gamma = 3;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sourceRead = createSourceReadTool({ runtime });
    const [prepare] = createSourcePatchTools({ runtime });

    const readResult = await sourceRead.execute(
      "tc-preview-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: 1, end_line: 1 }],
      },
      undefined,
      undefined,
      fakeContext("tc-preview"),
    );
    const readDetails = (readResult as { details?: SourceReadToolDetails }).details;
    if (!readDetails) {
      throw new Error("Missing source_read details.");
    }

    const prepareResult = await prepare.execute(
      "tc-preview-prepare",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri: readDetails.resourceUri,
            snapshot_id: readDetails.snapshot.id,
            start_anchor: requireAnchor(readDetails, 1),
            end_anchor: requireAnchor(readDetails, 2),
            replacement: "export const alpha = 10;\n\nexport const beta = 2;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-preview"),
    );

    const plan = (prepareResult as { details?: { plan?: SourcePatchPlan } }).details?.plan;
    expect(plan?.preview).toContain("\n-\n");
    expect(plan?.preview).toContain("\n+\n");
    expect(readFileSync(filePath, "utf8")).toContain("export const alpha = 1;");
  });

  test("source_patch_apply preserves UTF-8 BOM while replacing the first line", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-bom-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "\uFEFFexport const value = 1;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sourceRead = createSourceReadTool({ runtime });
    const [prepare, apply] = createSourcePatchTools({ runtime });

    const readResult = await sourceRead.execute(
      "tc-bom-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: 1, end_line: 1 }],
      },
      undefined,
      undefined,
      fakeContext("tc-bom"),
    );
    const readDetails = (readResult as { details?: SourceReadToolDetails }).details;
    if (!readDetails) {
      throw new Error("Missing source_read details.");
    }

    const prepareResult = await prepare.execute(
      "tc-bom-prepare",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri: readDetails.resourceUri,
            snapshot_id: readDetails.snapshot.id,
            start_anchor: requireAnchor(readDetails, 1),
            replacement: "export const value = 2;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-bom"),
    );
    const planId = (prepareResult as { details?: { planId?: string } }).details?.planId;

    await apply.execute(
      "tc-bom-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-bom"),
    );

    const after = readFileSync(filePath, "utf8");
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain("export const value = 2;");
  });

  test("source_patch_prepare rejects generated file targets before mutation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-generated-policy-"));
    const filePath = join(workspace, "schema.generated.ts");
    writeFileSync(
      filePath,
      "// Code generated by openapi-generator. DO NOT EDIT.\nexport {};\n",
      "utf8",
    );
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sourceRead = createSourceReadTool({ runtime });
    const [prepare] = createSourcePatchTools({ runtime });

    const readResult = await sourceRead.execute(
      "tc-generated-read",
      {
        uri: "schema.generated.ts",
        mode: "spans",
        spans: [{ start_line: 2, end_line: 2 }],
      },
      undefined,
      undefined,
      fakeContext("tc-generated-policy"),
    );
    const readDetails = (readResult as { details?: SourceReadToolDetails }).details;
    if (!readDetails) {
      throw new Error("Missing source_read details.");
    }

    const result = await prepare.execute(
      "tc-generated-prepare",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri: readDetails.resourceUri,
            snapshot_id: readDetails.snapshot.id,
            start_anchor: requireAnchor(readDetails, 2),
            replacement: "export const changed = true;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-generated-policy"),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("generated_file_rejected");
    expect(readFileSync(filePath, "utf8")).toContain("export {};");
  });

  test("source_patch_apply refuses conflicted plans without partial mutation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-conflict-apply-"));
    const sourcePath = join(workspace, "example.ts");
    const generatedPath = join(workspace, "schema.generated.ts");
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
    writeFileSync(
      generatedPath,
      "// Code generated by openapi-generator. DO NOT EDIT.\nexport {};\n",
      "utf8",
    );
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sourceRead = createSourceReadTool({ runtime });
    const [prepare, apply] = createSourcePatchTools({ runtime });

    const sourceReadResult = await sourceRead.execute(
      "tc-conflict-source-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: 1, end_line: 1 }],
      },
      undefined,
      undefined,
      fakeContext("tc-conflict-apply"),
    );
    const generatedReadResult = await sourceRead.execute(
      "tc-conflict-generated-read",
      {
        uri: "schema.generated.ts",
        mode: "spans",
        spans: [{ start_line: 2, end_line: 2 }],
      },
      undefined,
      undefined,
      fakeContext("tc-conflict-apply"),
    );
    const sourceDetails = (sourceReadResult as { details?: SourceReadToolDetails }).details;
    const generatedDetails = (generatedReadResult as { details?: SourceReadToolDetails }).details;
    if (!sourceDetails || !generatedDetails) {
      throw new Error("Missing source_read details.");
    }

    const prepareResult = await prepare.execute(
      "tc-conflict-prepare",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri: sourceDetails.resourceUri,
            snapshot_id: sourceDetails.snapshot.id,
            start_anchor: requireAnchor(sourceDetails, 1),
            replacement: "export const value = 2;",
          },
          {
            kind: "replace_anchor",
            uri: generatedDetails.resourceUri,
            snapshot_id: generatedDetails.snapshot.id,
            start_anchor: requireAnchor(generatedDetails, 2),
            replacement: "export const generated = false;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-conflict-apply"),
    );
    const planId = (prepareResult as { details?: { planId?: string } }).details?.planId;
    expect(
      extractTextContent(prepareResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("generated_file_rejected");
    expect(planId).toMatch(/^plan_/u);

    const applyResult = await apply.execute(
      "tc-conflict-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-conflict-apply"),
    );

    expect(
      extractTextContent(applyResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: failed");
    expect(readFileSync(sourcePath, "utf8")).toContain("value = 1");
    expect(readFileSync(generatedPath, "utf8")).toContain("export {};");
  });

  test("source_patch_apply replays source snapshots and plans from runtime events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-replay-"));
    const filePath = join(workspace, "example.ts");
    const before = "export const value = 1;\n";
    writeFileSync(filePath, before, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const [, apply] = createSourcePatchTools({ runtime });
    const sessionId = "tc-source-patch-replay";
    const uri = "brewva-resource:///file/example.ts";
    const snapshot = manualSnapshot({
      id: "snap_replay_manual",
      uri,
      path: filePath,
      text: before,
    });
    const anchor = snapshot.anchors[0];
    if (!anchor) {
      throw new Error("Missing manual anchor.");
    }
    const plan: SourcePatchPlan = {
      id: "plan_replay_manual",
      status: "prepared",
      createdAt: 2,
      summary: "manual replay",
      snapshots: [snapshot.id],
      intents: [
        {
          kind: "replace_anchor",
          uri,
          snapshotId: snapshot.id,
          startAnchor: `L${anchor.line}@${anchor.token}`,
          replacement: "export const value = 2;",
        },
      ],
      changes: [],
      conflicts: [],
      preflight: {
        ok: true,
        staleRecovered: false,
        generatedFileRejected: false,
      },
      preview: "",
    };
    runtime.ops.tools.sourcePatch.snapshots.record(sessionId, snapshot);
    runtime.ops.tools.sourcePatch.plans.prepare(sessionId, plan);

    const result = await apply.execute(
      "tc-source-patch-replay-apply",
      { plan_id: plan.id },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: applied");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("source_patch_prepare replays source snapshots from runtime events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-prepare-replay-"));
    const filePath = join(workspace, "example.ts");
    const before = "export const value = 1;\n";
    writeFileSync(filePath, before, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const [prepare] = createSourcePatchTools({ runtime });
    const sessionId = "tc-source-prepare-replay";
    const uri = "brewva-resource:///file/example.ts";
    const snapshot = manualSnapshot({
      id: "snap_prepare_replay_manual",
      uri,
      path: filePath,
      text: before,
    });
    const anchor = snapshot.anchors[0];
    if (!anchor) {
      throw new Error("Missing manual anchor.");
    }
    runtime.ops.tools.sourcePatch.snapshots.record(sessionId, snapshot);

    const result = await prepare.execute(
      "tc-source-prepare-replay",
      {
        edits: [
          {
            kind: "replace_anchor",
            uri,
            snapshot_id: snapshot.id,
            start_anchor: `L${anchor.line}@${anchor.token}`,
            replacement: "export const value = 3;",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: prepared");
  });

  test("resource_read replays conflict resources from runtime plan events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-conflict-resource-replay-"));
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const tool = createResourceReadTool({ runtime });
    const sessionId = "tc-conflict-resource-replay";
    const plan: SourcePatchPlan = {
      id: "plan_conflict_replay",
      status: "conflict",
      createdAt: 1,
      snapshots: [],
      intents: [],
      changes: [],
      conflicts: [
        {
          uri: "brewva-resource:///file/schema.generated.ts",
          reason: "generated_file_rejected",
          message: "Generated files cannot be mutated.",
        },
      ],
      preflight: {
        ok: false,
        staleRecovered: false,
        generatedFileRejected: true,
        reason: "generated_file_rejected",
      },
      preview: "",
    };
    runtime.ops.tools.sourcePatch.plans.prepare(sessionId, plan);

    const result = await tool.execute(
      "tc-conflict-resource-replay",
      { uri: `brewva-resource:///conflict/${plan.id}` },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("generated_file_rejected");
  });

  test("source_patch_prepare rejects rename destination collisions", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-rename-collision-"));
    const oldPath = join(workspace, "old.ts");
    const newPath = join(workspace, "new.ts");
    writeFileSync(oldPath, "export const oldValue = 1;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const [prepare, apply] = createSourcePatchTools({ runtime });

    const prepareResult = await prepare.execute(
      "tc-rename-collision-prepare",
      {
        edits: [
          {
            kind: "rename_file",
            uri: "brewva-resource:///file/old.ts",
            new_uri: "brewva-resource:///file/new.ts",
          },
          {
            kind: "create_file",
            uri: "brewva-resource:///file/new.ts",
            content: "export const newValue = 2;\n",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-rename-collision"),
    );
    const planId = (prepareResult as { details?: { planId?: string } }).details?.planId;
    expect(
      extractTextContent(prepareResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("path_conflict");

    await apply.execute(
      "tc-rename-collision-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-rename-collision"),
    );

    expect(readFileSync(oldPath, "utf8")).toContain("oldValue");
    expect(existsSync(newPath)).toBe(false);
  });

  test("resource_read supports agent field selection through the default router provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-read-agent-"));
    const baseRuntime = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = new Proxy(baseRuntime, {
      get(target, property, receiver) {
        if (property === "delegation") {
          return {
            listRuns: (): DelegationRunRecord[] => [
              {
                runId: "agent-1",
                parentSessionId: "tc-resource-agent",
                agent: "worker",
                targetName: "agent-1",
                taskName: "agent resource",
                taskPath: "agent-resource",
                depth: 1,
                forkTurns: "none",
                gateReason: "none",
                modelCategory: "default",
                delegate: "worker",
                status: "completed",
                createdAt: 1,
                updatedAt: 2,
                outcome: {
                  summary: "small answer",
                  transcript: "large transcript",
                },
              },
            ],
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof baseRuntime & {
      delegation: {
        listRuns: () => DelegationRunRecord[];
      };
    };
    const tool = createResourceReadTool({ runtime });

    const result = await tool.execute(
      "tc-resource-agent",
      { uri: "brewva-resource:///agent/agent-1/outcome.summary" },
      undefined,
      undefined,
      fakeContext("tc-resource-agent"),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain('"small answer"');
  });

  test("worker_results_apply prepares worker patches as SourcePatchPlan before applying", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-worker-source-patch-"));
    const sourcePath = join(workspace, "example.ts");
    const artifactDir = join(workspace, ".orchestrator/subagent-patch-artifacts/patch-worker");
    const artifactPath = join(artifactDir, "example.ts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
    writeFileSync(artifactPath, "export const value = 2;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    runtime.ops.session.workerResults.record("tc-worker-results", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "example.ts",
            action: "modify",
            artifactRef: ".orchestrator/subagent-patch-artifacts/patch-worker/example.ts",
          },
        ],
      },
    });
    const tool = createWorkerResultsApplyTool({ runtime });

    const prepared = await tool.execute(
      "tc-worker-prepare",
      {},
      undefined,
      undefined,
      fakeContext("tc-worker-results"),
    );
    const planId = (prepared as { details?: { planId?: string } }).details?.planId;
    expect(planId).toMatch(/^plan_/u);
    expect(readFileSync(sourcePath, "utf8")).toContain("value = 1");

    await tool.execute(
      "tc-worker-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-worker-results"),
    );
    expect(readFileSync(sourcePath, "utf8")).toContain("value = 2");
  });

  test("worker_results_apply reports SourcePatchPlan conflicts during prepare", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-worker-source-patch-conflict-"));
    const sourcePath = join(workspace, "schema.generated.ts");
    const artifactDir = join(workspace, ".orchestrator/subagent-patch-artifacts/patch-worker");
    const artifactPath = join(artifactDir, "schema.generated.ts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      sourcePath,
      "// Code generated by openapi-generator. DO NOT EDIT.\nexport {};\n",
      "utf8",
    );
    writeFileSync(artifactPath, "export const generated = false;\n", "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    runtime.ops.session.workerResults.record("tc-worker-results-conflict", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "schema.generated.ts",
            action: "modify",
            artifactRef: ".orchestrator/subagent-patch-artifacts/patch-worker/schema.generated.ts",
          },
        ],
      },
    });
    const tool = createWorkerResultsApplyTool({ runtime });

    const prepared = await tool.execute(
      "tc-worker-prepare-conflict",
      {},
      undefined,
      undefined,
      fakeContext("tc-worker-results-conflict"),
    );

    expect(
      extractTextContent(prepared as { content: Array<{ type: string; text?: string }> }),
    ).toContain("generated_file_rejected");
    expect((prepared as { details?: { status?: string } }).details?.status).toBe("conflict");
    expect(readFileSync(sourcePath, "utf8")).toContain("export {};");
  });
});
