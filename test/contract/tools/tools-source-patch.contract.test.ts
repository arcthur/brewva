import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex, shortSha256Hex } from "@brewva/brewva-std/hash";
import {
  createResourceReadTool,
  createSourcePatchTools,
  createSourceReadTool,
  type SourceReadToolDetails,
} from "@brewva/brewva-tools/navigation";
import {
  createWorkerResultsApplyTool,
  createWorkerResultsRejectTool,
} from "@brewva/brewva-tools/workflow";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_REJECTED_EVENT_TYPE,
  type DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import type { SourcePatchPlan, SourceSnapshot } from "@brewva/brewva-vocabulary/workbench";
import { createBundledToolRuntime, createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const details = toolOutcomePayload(result) as SourceReadToolDetails;
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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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

    const details = toolOutcomePayload(result) as SourceReadToolDetails;
    expect(details?.resourceUri).toBe("brewva-resource:///file/example.ts");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("L1@");
  });

  test("source_read rejects runtime tape resources before file read", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-read-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "tape", "session.jsonl"),
      `${JSON.stringify({
        id: "evt-source-read-tape",
        sessionId: "tc-source-read-runtime-tape",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "needle",
          content: [{ type: "text", text: "needle" }],
        },
      })}\n`,
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createSourceReadTool({ runtime });

    const result = await tool.execute(
      "tc-source-read-runtime-tape",
      {
        uri: ".brewva/tape/session.jsonl",
        mode: "raw",
      },
      undefined,
      undefined,
      fakeContext("tc-source-read-runtime-tape"),
    );

    expect(result.outcome.kind).toBe("err");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      artifact: "tape",
    });
  });

  test("resource_read rejects runtime tape resources before router read", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-read-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "tape", "session.jsonl"),
      `${JSON.stringify({
        id: "evt-resource-read-tape",
        sessionId: "tc-resource-read-runtime-tape",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "needle",
          content: [{ type: "text", text: "needle" }],
        },
      })}\n`,
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createResourceReadTool({ runtime });

    const result = await tool.execute(
      "tc-resource-read-runtime-tape",
      {
        uri: ".brewva/tape/session.jsonl",
      },
      undefined,
      undefined,
      fakeContext("tc-resource-read-runtime-tape"),
    );

    expect(result.outcome.kind).toBe("err");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      artifact: "tape",
    });
  });

  test("source_patch_prepare rejects runtime tape mutation targets", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const [prepare] = createSourcePatchTools({ runtime });

    const result = await prepare.execute(
      "tc-source-patch-runtime-tape",
      {
        edits: [
          {
            kind: "create_file",
            uri: ".brewva/tape/injected.jsonl",
            content: "not canonical\n",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("tc-source-patch-runtime-tape"),
    );

    const details = toolOutcomePayload(result) as {
      status?: string;
      conflicts?: Array<{ reason?: string }>;
    };
    expect(result.outcome.kind).toBe("err");
    expect(details.status).toBe("conflict");
    expect(details.conflicts?.[0]?.reason).toBe("runtime_artifact_read_denied");
    expect(existsSync(join(workspace, ".brewva", "tape", "injected.jsonl"))).toBe(false);
  });

  test("source_patch_prepare and source_patch_apply are the only source mutation path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "export const alpha = 1;\nexport const beta = 2;\n", "utf8");
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const readDetails = toolOutcomePayload(readResult) as SourceReadToolDetails;
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
    const prepareDetails = toolOutcomePayload(prepareResult) as { planId?: string };
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
    const applyDetails = toolOutcomePayload(applyResult) as {
      patchSet?: { rollbackArtifactRef?: string } | null;
    };
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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const readDetails = toolOutcomePayload(readResult) as SourceReadToolDetails;
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

    const plan = (toolOutcomePayload(prepareResult) as { plan?: SourcePatchPlan }).plan;
    expect(plan?.preview).toContain("\n-\n");
    expect(plan?.preview).toContain("\n+\n");
    expect(readFileSync(filePath, "utf8")).toContain("export const alpha = 1;");
  });

  test("source_patch_apply preserves UTF-8 BOM while replacing the first line", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-bom-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "\uFEFFexport const value = 1;\n", "utf8");
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const readDetails = toolOutcomePayload(readResult) as SourceReadToolDetails;
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
    const planId = (toolOutcomePayload(prepareResult) as { planId?: string }).planId;

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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const readDetails = toolOutcomePayload(readResult) as SourceReadToolDetails;
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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const sourceDetails = toolOutcomePayload(sourceReadResult) as SourceReadToolDetails;
    const generatedDetails = toolOutcomePayload(generatedReadResult) as SourceReadToolDetails;
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
    const planId = (toolOutcomePayload(prepareResult) as { planId?: string }).planId;
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
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
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
    adapter.ops.tools.sourcePatch.snapshots.record(sessionId, snapshot);
    adapter.ops.tools.sourcePatch.plans.prepare(sessionId, plan);

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
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
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
    adapter.ops.tools.sourcePatch.snapshots.record(sessionId, snapshot);

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
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
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
    adapter.ops.tools.sourcePatch.plans.prepare(sessionId, plan);

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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
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
    const planId = (toolOutcomePayload(prepareResult) as { planId?: string }).planId;
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
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }), {
      delegation: {
        listRuns: (): DelegationRunRecord[] => [
          {
            contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
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
      },
    });
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
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-results", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "example.ts",
            action: "modify",
            beforeHash: sha256Hex("export const value = 1;\n"),
            afterHash: sha256Hex("export const value = 2;\n"),
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
    const planId = (toolOutcomePayload(prepared) as { planId?: string }).planId;
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
    expect(adapter.ops.session.workerResults.list("tc-worker-results")).toEqual([]);
    expect(
      adapter.ops.events.records.query("tc-worker-results", {
        type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
      }),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          workerIds: ["worker-a"],
          planId,
        }),
      }),
    ]);
  });

  test("worker_results_apply rejects runtime tape patch targets before prepare", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-worker-runtime-tape-"));
    const artifactDir = join(workspace, ".orchestrator/subagent-patch-artifacts/patch-worker");
    const artifactPath = join(artifactDir, "payload.jsonl");
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(artifactPath, "not canonical\n", "utf8");
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-runtime-tape", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: ".brewva/tape/injected.jsonl",
            action: "add",
            artifactRef: ".orchestrator/subagent-patch-artifacts/patch-worker/payload.jsonl",
          },
        ],
      },
    });
    const tool = createWorkerResultsApplyTool({ runtime });

    const prepared = await tool.execute(
      "tc-worker-runtime-tape",
      {},
      undefined,
      undefined,
      fakeContext("tc-worker-runtime-tape"),
    );

    expect(prepared.outcome.kind).toBe("err");
    expect(toolOutcomePayload(prepared)).toMatchObject({
      status: "prepare_failed",
      reason: "runtime_artifact_read_denied",
      path: ".brewva/tape/injected.jsonl",
    });
    expect(existsSync(join(workspace, ".brewva", "tape", "injected.jsonl"))).toBe(false);
  });

  test("worker_results_reject records explicit rejection and clears selected workers", async () => {
    const adapter = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-worker-reject-")),
    });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-reject", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-a",
        changes: [],
      },
    });
    adapter.ops.session.workerResults.record("tc-worker-reject", {
      workerId: "worker-b",
      status: "ok",
      patches: {
        id: "patch-b",
        changes: [],
      },
    });
    const tool = createWorkerResultsRejectTool({ runtime });

    const rejected = await tool.execute(
      "tc-worker-reject",
      { worker_ids: ["worker-a"], reason: "Superseded by parent implementation." },
      undefined,
      undefined,
      fakeContext("tc-worker-reject"),
    );

    expect(
      extractTextContent(rejected as { content: Array<{ type: string; text?: string }> }),
    ).toContain("Rejected worker results");
    expect(
      adapter.ops.session.workerResults.list("tc-worker-reject").map((result) => result.workerId),
    ).toEqual(["worker-b"]);
    expect(
      adapter.ops.events.records
        .query("tc-worker-reject", {
          type: WORKER_RESULTS_REJECTED_EVENT_TYPE,
        })
        .at(-1),
    ).toMatchObject({
      payload: {
        workerIds: ["worker-a"],
        reason: "Superseded by parent implementation.",
      },
    });
    expect(
      adapter.ops.events.records
        .query("tc-worker-reject", {
          type: "worker.results.cleared",
        })
        .at(-1),
    ).toMatchObject({
      payload: {
        workerIds: ["worker-a"],
        decision: "reject",
        reason: "Superseded by parent implementation.",
      },
    });
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
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-results-conflict", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "schema.generated.ts",
            action: "modify",
            beforeHash: sha256Hex(
              "// Code generated by openapi-generator. DO NOT EDIT.\nexport {};\n",
            ),
            afterHash: sha256Hex("export const generated = false;\n"),
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
    expect((toolOutcomePayload(prepared) as { status?: string }).status).toBe("conflict");
    expect(readFileSync(sourcePath, "utf8")).toContain("export {};");
  });

  test("worker_results_apply fails closed when the parent diverged from the fork basis", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-worker-basis-conflict-"));
    const sourcePath = join(workspace, "example.ts");
    const artifactDir = join(workspace, ".orchestrator/subagent-patch-artifacts/patch-worker");
    mkdirSync(artifactDir, { recursive: true });
    // The worker forked when the file said value = 1 ...
    const basisText = "export const value = 1;\n";
    writeFileSync(join(artifactDir, "example.ts"), "export const value = 2;\n", "utf8");
    // ... but the parent has since moved the same file.
    writeFileSync(sourcePath, "export const value = 777; // parent moved\n", "utf8");
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-basis-conflict", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "example.ts",
            action: "modify",
            beforeHash: sha256Hex(basisText),
            afterHash: sha256Hex("export const value = 2;\n"),
            artifactRef: ".orchestrator/subagent-patch-artifacts/patch-worker/example.ts",
          },
        ],
      },
    });
    const tool = createWorkerResultsApplyTool({ runtime });

    const prepared = await tool.execute(
      "tc-worker-basis-conflict",
      {},
      undefined,
      undefined,
      fakeContext("tc-worker-basis-conflict"),
    );

    expect((toolOutcomePayload(prepared) as { status?: string }).status).toBe("basis_conflict");
    expect(
      extractTextContent(prepared as { content: Array<{ type: string; text?: string }> }),
    ).toContain("parent_diverged");
    // Fail-closed: the parent's divergent content is untouched.
    expect(readFileSync(sourcePath, "utf8")).toContain("value = 777");
    const failed = adapter.ops.events.records.query("tc-worker-basis-conflict", {
      type: "worker.results.apply_failed",
    });
    expect(failed).toHaveLength(1);
    const failedPayload = failed[0]?.payload as { reason?: string } | undefined;
    expect(failedPayload?.reason).toBe("basis_conflict");
  });

  test("worker_results_apply settles already-present changes as a no-op adoption", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-worker-basis-noop-"));
    const sourcePath = join(workspace, "example.ts");
    const artifactDir = join(workspace, ".orchestrator/subagent-patch-artifacts/patch-worker");
    mkdirSync(artifactDir, { recursive: true });
    // The parent already carries the worker's result content.
    writeFileSync(sourcePath, "export const value = 2;\n", "utf8");
    writeFileSync(join(artifactDir, "example.ts"), "export const value = 2;\n", "utf8");
    const adapter = createRuntimeInstanceFixture({ cwd: workspace });
    const runtime = createBundledToolRuntime(adapter);
    adapter.ops.session.workerResults.record("tc-worker-basis-noop", {
      workerId: "worker-a",
      status: "ok",
      patches: {
        id: "patch-worker",
        changes: [
          {
            path: "example.ts",
            action: "modify",
            beforeHash: sha256Hex("export const value = 1;\n"),
            afterHash: sha256Hex("export const value = 2;\n"),
            artifactRef: ".orchestrator/subagent-patch-artifacts/patch-worker/example.ts",
          },
        ],
      },
    });
    const tool = createWorkerResultsApplyTool({ runtime });

    const result = await tool.execute(
      "tc-worker-basis-noop",
      {},
      undefined,
      undefined,
      fakeContext("tc-worker-basis-noop"),
    );

    const payload = toolOutcomePayload(result) as { status?: string; appliedPaths?: string[] };
    expect(payload.status).toBe("applied");
    expect(payload.appliedPaths).toEqual([]);
    // The worker set settles without a plan: cleared and receipted.
    expect(adapter.ops.session.workerResults.list("tc-worker-basis-noop")).toEqual([]);
    const applied = adapter.ops.events.records.query("tc-worker-basis-noop", {
      type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
    });
    expect(applied).toHaveLength(1);
    const appliedPayload = applied[0]?.payload as { reason?: string } | undefined;
    expect(appliedPayload?.reason).toBe("already_applied");
  });
});
