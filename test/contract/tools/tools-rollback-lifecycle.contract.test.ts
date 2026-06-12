import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourcePatchTools, createSourceReadTool } from "@brewva/brewva-tools/navigation";
import { createRollbackLastPatchTool } from "@brewva/brewva-tools/workflow";
import { ROLLBACK_EVENT_TYPE } from "@brewva/brewva-vocabulary/workbench";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

const SESSION_ID = "tc-rollback";
const ORIGINAL_TEXT = "export const alpha = 1;\nexport const beta = 2;\n";
const PATCHED_LINE = "export const beta = 20;";

interface SourceReadDetails {
  readonly resourceUri: string;
  readonly snapshot: {
    readonly id: string;
    readonly anchors: ReadonlyArray<{ readonly line: number; readonly token: string }>;
  };
}

async function applySamplePatch(input: {
  readonly runtime: ReturnType<typeof createRuntimeInstanceFixture>;
  readonly replacement: string;
}): Promise<{ patchSetId: string; rollbackArtifactRef: string }> {
  const sourceRead = createSourceReadTool({ runtime: input.runtime });
  const [prepare, apply] = createSourcePatchTools({ runtime: input.runtime });

  const readResult = await sourceRead.execute(
    "tc-rollback-read",
    { uri: "example.ts", mode: "spans", spans: [{ start_line: 2, end_line: 2 }] },
    undefined,
    undefined,
    fakeContext(SESSION_ID),
  );
  const readDetails = toolOutcomePayload(readResult) as SourceReadDetails;
  const anchor = readDetails.snapshot.anchors.find((candidate) => candidate.line === 2);
  if (!anchor) {
    throw new Error("missing_anchor");
  }

  const prepareResult = await prepare.execute(
    "tc-rollback-prepare",
    {
      edits: [
        {
          kind: "replace_anchor",
          uri: readDetails.resourceUri,
          snapshot_id: readDetails.snapshot.id,
          start_anchor: `L${anchor.line}@${anchor.token}`,
          replacement: input.replacement,
        },
      ],
    },
    undefined,
    undefined,
    fakeContext(SESSION_ID),
  );
  const prepareDetails = toolOutcomePayload(prepareResult) as { planId?: string };

  const applyResult = await apply.execute(
    "tc-rollback-apply",
    { plan_id: prepareDetails.planId },
    undefined,
    undefined,
    fakeContext(SESSION_ID),
  );
  const applyDetails = toolOutcomePayload(applyResult) as {
    patchSetId?: string;
    patchSet?: { rollbackArtifactRef?: string } | null;
  };
  if (!applyDetails.patchSetId || !applyDetails.patchSet?.rollbackArtifactRef) {
    throw new Error("source_patch_apply_did_not_track_rollback_material");
  }
  return {
    patchSetId: applyDetails.patchSetId,
    rollbackArtifactRef: applyDetails.patchSet.rollbackArtifactRef,
  };
}

describe("patch rollback lifecycle", () => {
  test("default hosted rollback restores tracked mutations and records evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-lifecycle-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, ORIGINAL_TEXT, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });

    const applied = await applySamplePatch({ runtime, replacement: PATCHED_LINE });
    expect(readFileSync(filePath, "utf8")).toContain(PATCHED_LINE);

    const candidate = runtime.capabilities.tools.patches.rollbackCandidate(SESSION_ID);
    expect(candidate).toMatchObject({
      available: true,
      patchSetId: applied.patchSetId,
      artifactAvailable: true,
    });
    expect(candidate.affectedPaths).toContain("example.ts");

    const rollback = runtime.capabilities.tools.patches.rollbackLastPatchSet(SESSION_ID);
    expect(rollback).toMatchObject({
      ok: true,
      patchSetId: applied.patchSetId,
      restoredPaths: ["example.ts"],
      failedPaths: [],
    });
    expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL_TEXT);

    const evidence = runtime.ops.events.records
      .list(SESSION_ID)
      .filter((event: { type: string }) => event.type === ROLLBACK_EVENT_TYPE);
    expect(evidence).toHaveLength(1);
    expect((evidence[0] as { payload?: unknown }).payload).toMatchObject({
      patchSetId: applied.patchSetId,
      ok: true,
    });

    // The rolled-back patch set is no longer a candidate.
    expect(runtime.capabilities.tools.patches.rollbackCandidate(SESSION_ID)).toMatchObject({
      available: false,
      noCandidateReason: "no_patchset",
    });
    expect(runtime.capabilities.tools.patches.rollbackLastPatchSet(SESSION_ID)).toMatchObject({
      ok: false,
      reason: "no_patchset",
    });
  });

  test("no-candidate is a first-class state, not an undo promise", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-empty-"));
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });

    expect(runtime.capabilities.tools.patches.rollbackCandidate(SESSION_ID)).toMatchObject({
      available: false,
      artifactAvailable: false,
      noCandidateReason: "no_patchset",
    });
    expect(runtime.capabilities.tools.patches.rollbackLastPatchSet(SESSION_ID)).toMatchObject({
      ok: false,
      restoredPaths: [],
      failedPaths: [],
      reason: "no_patchset",
    });
  });

  test("workspace drift after apply surfaces as conflict and mutates nothing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-conflict-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, ORIGINAL_TEXT, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });

    await applySamplePatch({ runtime, replacement: PATCHED_LINE });
    const drifted = "export const alpha = 1;\nexport const beta = 999;\n";
    writeFileSync(filePath, drifted, "utf8");

    const rollback = runtime.capabilities.tools.patches.rollbackLastPatchSet(SESSION_ID);
    expect(rollback).toMatchObject({
      ok: false,
      reason: "conflict",
      restoredPaths: [],
      failedPaths: ["example.ts"],
    });
    expect(readFileSync(filePath, "utf8")).toBe(drifted);
  });

  test("missing rollback material surfaces as artifact-missing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-artifact-missing-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, ORIGINAL_TEXT, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });

    const applied = await applySamplePatch({ runtime, replacement: PATCHED_LINE });
    const manifestPath = join(workspace, applied.rollbackArtifactRef);
    expect(existsSync(manifestPath)).toBe(true);
    rmSync(manifestPath);

    expect(runtime.capabilities.tools.patches.rollbackCandidate(SESSION_ID)).toMatchObject({
      available: false,
      artifactAvailable: false,
      noCandidateReason: "rollback_artifact_missing",
    });
    expect(runtime.capabilities.tools.patches.rollbackLastPatchSet(SESSION_ID)).toMatchObject({
      ok: false,
      reason: "rollback_artifact_missing",
    });
    expect(readFileSync(filePath, "utf8")).toContain(PATCHED_LINE);
  });

  test("rollback_last_patch tool reports lifecycle states through the same capability", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-tool-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, ORIGINAL_TEXT, "utf8");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const tool = createRollbackLastPatchTool({ runtime });

    await applySamplePatch({ runtime, replacement: PATCHED_LINE });
    const result = await tool.execute(
      "tc-rollback-tool",
      {},
      undefined,
      undefined,
      fakeContext(SESSION_ID),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Rolled back patch set:");
    expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL_TEXT);

    const repeat = await tool.execute(
      "tc-rollback-tool-repeat",
      {},
      undefined,
      undefined,
      fakeContext(SESSION_ID),
    );
    expect(
      extractTextContent(repeat as { content: Array<{ type: string; text?: string }> }),
    ).toContain("No tracked patch set is available to roll back.");
  });
});
