import { describe, expect, test } from "bun:test";
import {
  type PatchSet,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_PATCH_PREPARED_EVENT_TYPE,
  SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE,
  SOURCE_RESOURCE_READ_EVENT_TYPE,
  SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
  type SourcePatchApplyResult,
  type SourcePatchPlan,
  type SourceSnapshot,
} from "@brewva/brewva-vocabulary/workbench";

describe("source patch protocol", () => {
  test("exposes source snapshot and source patch event constants", () => {
    expect(SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE).toBe("source_snapshot_recorded");
    expect(SOURCE_RESOURCE_READ_EVENT_TYPE).toBe("source_resource_read");
    expect(SOURCE_PATCH_PREPARED_EVENT_TYPE).toBe("source_patch_prepared");
    expect(SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE).toBe("source_patch_stale_recovered");
    expect(SOURCE_PATCH_APPLIED_EVENT_TYPE).toBe("source_patch_applied");
  });

  test("source patch records link to patch sets without widening PatchSet callers", () => {
    const snapshot = {
      id: "snap_test",
      uri: "brewva-resource:///file/src/example.ts",
      path: "/tmp/workspace/src/example.ts",
      contentHash: "sha256:content",
      createdAt: 1,
      lineCount: 1,
      anchors: [
        {
          line: 1,
          text: "export const value = 1;",
        },
      ],
      seenLines: [1],
    } satisfies SourceSnapshot;

    const plan = {
      id: "plan_test",
      status: "prepared",
      createdAt: 2,
      summary: "Rename value",
      snapshots: [snapshot.id],
      intents: [
        {
          kind: "replace_lines",
          uri: snapshot.uri,
          snapshotId: snapshot.id,
          startLine: 1,
          replacement: "export const value = 2;",
        },
      ],
      changes: [
        {
          path: "/tmp/workspace/src/example.ts",
          action: "modify",
          beforeHash: "sha256:content",
          afterHash: "sha256:after",
        },
      ],
      conflicts: [],
      preflight: {
        ok: true,
        staleRecovered: false,
        generatedFileRejected: false,
      },
      preview: "--- before\n+++ after\n",
    } satisfies SourcePatchPlan;

    const patchSet = {
      id: "patch_test",
      sourcePatchPlanId: plan.id,
      sourceSnapshotIds: [snapshot.id],
      preflight: plan.preflight,
      rollbackArtifactRef: "artifact://rollback",
      changes: plan.changes,
    } satisfies PatchSet;

    const applyResult = {
      ok: true,
      planId: plan.id,
      patchSetId: patchSet.id,
      appliedPaths: ["/tmp/workspace/src/example.ts"],
      failedPaths: [],
    } satisfies SourcePatchApplyResult;

    expect(applyResult.planId).toBe(plan.id);
    expect(patchSet.sourcePatchPlanId).toBe(plan.id);
    expect(patchSet.sourceSnapshotIds).toEqual([snapshot.id]);
  });
});
