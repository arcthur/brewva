import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  executePatchSetRollback,
  resolveLatestRollbackCandidate,
  type RollbackManifestEntry,
} from "@brewva/brewva-tools/patch-lifecycle";

const SESSION_ID = "patch-lifecycle-session";
const PATCH_SET_ID = "patch_lifecycle_set";

function hash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

function createWorkspace(entries: readonly RollbackManifestEntry[]): string {
  const workspace = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-"));
  const patchDir = join(workspace, SESSION_ID, PATCH_SET_ID);
  mkdirSync(join(patchDir, "before"), { recursive: true });
  writeFileSync(
    join(patchDir, "rollback.json"),
    JSON.stringify({ version: 1, patchSetId: PATCH_SET_ID, createdAt: 1, entries }, null, 2),
    "utf8",
  );
  return workspace;
}

function writeBeforeArtifact(workspace: string, name: string, content: string): string {
  const ref = `${SESSION_ID}/${PATCH_SET_ID}/before/${name}`;
  writeFileSync(join(workspace, ref), content, "utf8");
  return ref;
}

function resolveCandidate(workspace: string) {
  const resolution = resolveLatestRollbackCandidate({
    workspaceRoot: workspace,
    sessionId: SESSION_ID,
    appliedPatchSets: [{ patchSetId: PATCH_SET_ID }],
    rolledBackPatchSetIds: new Set(),
  });
  if (resolution.kind !== "candidate") {
    throw new Error(`expected_candidate:${resolution.kind}`);
  }
  return resolution.candidate;
}

describe("patch lifecycle rollback module", () => {
  test("restores a rename and refuses to overwrite a foreign occupant of the restore target", () => {
    const before = "export const value = 1;\n";
    const entries: RollbackManifestEntry[] = [
      {
        path: "a.ts",
        operation: "rename",
        oldPath: "a.ts",
        newPath: "b.ts",
        beforeHash: hash(before),
      },
    ];

    // Clean world: rename back succeeds.
    const cleanWorkspace = createWorkspace(entries);
    writeFileSync(join(cleanWorkspace, "b.ts"), before, "utf8");
    const clean = executePatchSetRollback({
      workspaceRoot: cleanWorkspace,
      candidate: resolveCandidate(cleanWorkspace),
    });
    expect(clean).toMatchObject({ ok: true, restoredPaths: ["a.ts"] });
    expect(readFileSync(join(cleanWorkspace, "a.ts"), "utf8")).toBe(before);
    expect(existsSync(join(cleanWorkspace, "b.ts"))).toBe(false);

    // Drifted world: a new file occupies the restore target; nothing moves.
    const driftedWorkspace = createWorkspace(entries);
    writeFileSync(join(driftedWorkspace, "b.ts"), before, "utf8");
    writeFileSync(join(driftedWorkspace, "a.ts"), "// brand new unrelated file\n", "utf8");
    const drifted = executePatchSetRollback({
      workspaceRoot: driftedWorkspace,
      candidate: resolveCandidate(driftedWorkspace),
    });
    expect(drifted).toMatchObject({ ok: false, reason: "conflict", restoredPaths: [] });
    expect(readFileSync(join(driftedWorkspace, "a.ts"), "utf8")).toBe(
      "// brand new unrelated file\n",
    );
    expect(existsSync(join(driftedWorkspace, "b.ts"))).toBe(true);
  });

  test("validates the simulated post-apply state for intra-patchset path interactions", () => {
    const created = "export const created = true;\n";
    const entries: RollbackManifestEntry[] = [
      // The patch created a.ts (no before artifact)...
      { path: "a.ts", operation: "write", afterHash: hash(created) },
      // ...then renamed it to b.ts, so post-apply a.ts is absent.
      { path: "a.ts", operation: "rename", oldPath: "a.ts", newPath: "b.ts" },
    ];
    const workspace = createWorkspace(entries);
    writeFileSync(join(workspace, "b.ts"), created, "utf8");

    const execution = executePatchSetRollback({
      workspaceRoot: workspace,
      candidate: resolveCandidate(workspace),
    });
    // Reverse order: rename back first, then remove the created file.
    expect(execution.ok).toBe(true);
    expect(existsSync(join(workspace, "a.ts"))).toBe(false);
    expect(existsSync(join(workspace, "b.ts"))).toBe(false);
  });

  test("missing before material for a delete surfaces as artifact-missing without mutation", () => {
    const entries: RollbackManifestEntry[] = [
      { path: "gone.ts", operation: "delete", beforeHash: hash("old content\n") },
    ];
    const workspace = createWorkspace(entries);

    const execution = executePatchSetRollback({
      workspaceRoot: workspace,
      candidate: resolveCandidate(workspace),
    });
    expect(execution).toMatchObject({
      ok: false,
      reason: "rollback_artifact_missing",
      restoredPaths: [],
      failedPaths: ["gone.ts"],
    });
  });

  test("a tampered manifest can never write outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-outside-"));
    const victimPath = join(outside, "victim.txt");
    writeFileSync(victimPath, "untouched\n", "utf8");

    const hostileManifests: ReadonlyArray<Record<string, unknown>> = [
      // Absolute restore target.
      { path: victimPath, operation: "write" },
      // Traversal restore target.
      { path: "../escape.txt", operation: "write" },
      // Rename whose restore target escapes via traversal.
      { path: "a.ts", operation: "rename", oldPath: "../../escape.ts", newPath: "b.ts" },
      // Artifact ref outside the patch-set directory.
      {
        path: "a.ts",
        operation: "delete",
        beforeHash: hash("x"),
        beforeArtifactRef: "../../secrets.txt",
      },
      // Unknown operation.
      { path: "a.ts", operation: "exec" },
    ];

    for (const entry of hostileManifests) {
      const workspace = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-hostile-"));
      const patchDir = join(workspace, SESSION_ID, PATCH_SET_ID);
      mkdirSync(patchDir, { recursive: true });
      writeFileSync(
        join(patchDir, "rollback.json"),
        JSON.stringify({ version: 1, patchSetId: PATCH_SET_ID, createdAt: 1, entries: [entry] }),
        "utf8",
      );
      const resolution = resolveLatestRollbackCandidate({
        workspaceRoot: workspace,
        sessionId: SESSION_ID,
        appliedPatchSets: [{ patchSetId: PATCH_SET_ID }],
        rolledBackPatchSetIds: new Set(),
      });
      // The whole manifest is rejected; no entry is silently dropped and no
      // candidate is offered.
      expect(resolution).toEqual({ kind: "none", reason: "rollback_artifact_invalid" });
    }
    expect(readFileSync(victimPath, "utf8")).toBe("untouched\n");
  });

  test("a manifest claiming a different patch set id is invalid", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-id-mismatch-"));
    const patchDir = join(workspace, SESSION_ID, PATCH_SET_ID);
    mkdirSync(patchDir, { recursive: true });
    writeFileSync(
      join(patchDir, "rollback.json"),
      JSON.stringify({ version: 1, patchSetId: "patch_other", createdAt: 1, entries: [] }),
      "utf8",
    );
    expect(
      resolveLatestRollbackCandidate({
        workspaceRoot: workspace,
        sessionId: SESSION_ID,
        appliedPatchSets: [{ patchSetId: PATCH_SET_ID }],
        rolledBackPatchSetIds: new Set(),
      }),
    ).toEqual({ kind: "none", reason: "rollback_artifact_invalid" });
  });

  test("discovery prefers the artifact identity recorded on the apply receipt", () => {
    const before = "export const recorded = true;\n";
    const workspace = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-recorded-ref-"));
    const customDir = join(workspace, "custom-artifacts", PATCH_SET_ID);
    mkdirSync(join(customDir, "before"), { recursive: true });
    const ref = `custom-artifacts/${PATCH_SET_ID}/before/0000_file.ts.txt`;
    writeFileSync(join(workspace, ref), before, "utf8");
    const manifestRef = `custom-artifacts/${PATCH_SET_ID}/rollback.json`;
    writeFileSync(
      join(workspace, manifestRef),
      JSON.stringify({
        version: 1,
        patchSetId: PATCH_SET_ID,
        createdAt: 1,
        entries: [
          {
            path: "file.ts",
            operation: "delete",
            beforeHash: hash(before),
            beforeArtifactRef: ref,
          },
        ],
      }),
      "utf8",
    );

    const resolution = resolveLatestRollbackCandidate({
      workspaceRoot: workspace,
      sessionId: SESSION_ID,
      appliedPatchSets: [{ patchSetId: PATCH_SET_ID, rollbackArtifactRef: manifestRef }],
      rolledBackPatchSetIds: new Set(),
    });
    expect(resolution.kind).toBe("candidate");
    if (resolution.kind !== "candidate") {
      throw new Error("expected_candidate");
    }
    expect(resolution.candidate.manifestPath).toBe(join(workspace, manifestRef));
  });

  test("restores deletes from captured before content", () => {
    const before = "export const restored = true;\n";
    const workspace = mkdtempSync(join(tmpdir(), "brewva-patch-lifecycle-delete-"));
    const patchDir = join(workspace, SESSION_ID, PATCH_SET_ID);
    mkdirSync(join(patchDir, "before"), { recursive: true });
    const ref = writeBeforeArtifact(workspace, "0000_gone.ts.txt", before);
    writeFileSync(
      join(patchDir, "rollback.json"),
      JSON.stringify(
        {
          version: 1,
          patchSetId: PATCH_SET_ID,
          createdAt: 1,
          entries: [
            {
              path: "gone.ts",
              operation: "delete",
              beforeHash: hash(before),
              beforeArtifactRef: ref,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const execution = executePatchSetRollback({
      workspaceRoot: workspace,
      candidate: resolveCandidate(workspace),
    });
    expect(execution).toMatchObject({ ok: true, restoredPaths: ["gone.ts"] });
    expect(readFileSync(join(workspace, "gone.ts"), "utf8")).toBe(before);
  });
});
