import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAppliedPatchSetIds } from "@brewva/brewva-vocabulary/workbench";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import { createRuntimeConfig } from "../../helpers/runtime.js";

// Coupled world rewind RFC, Phase 2: a workspace (`both`/`code`) rewind
// restores the checkpoint's captured world — including files an exec-style
// direct write mutated, which the patch lane never covered — and falls back to
// the patch lane when the world is unusable. Real filesystem I/O.
setDefaultTimeout(60_000);

const SESSION_ID = "world-rewind-session";

function worldsEnabledAdapter(cwd: string) {
  const config = createRuntimeConfig((draft) => {
    draft.worlds.enabled = true;
  });
  return createHostedRuntimeAdapter({ cwd, config });
}

describe("world-restore rewind lane (coupled world rewind RFC, Phase 2)", () => {
  test("both-mode rewind restores exec-written damage back to the checkpoint world", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-"));
    writeFileSync(join(cwd, "notes.txt"), "original content\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    // Post-checkpoint damage the patch lifecycle never saw: a direct rewrite
    // and a stray created file — the exact case that was unrestorable before
    // the world lane existed.
    writeFileSync(join(cwd, "notes.txt"), "exec damaged this\n", "utf8");
    writeFileSync(join(cwd, "junk.txt"), "stray artifact\n", "utf8");

    const result = runtime.ops.session.rewind.rewind(SESSION_ID, { mode: "both" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected world-lane rewind ok");
    expect(result.worldRestore?.wroteFileCount).toBe(1);
    expect(result.worldRestore?.deletedFileCount).toBe(1);
    expect(typeof result.worldRestore?.fromWorldId).toBe("string");
    expect(result.worldRestore?.fromWorldId).not.toBe(result.worldRestore?.worldId);

    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("original content\n");
    expect(existsSync(join(cwd, "junk.txt"))).toBe(false);
  });

  test("the restore leaves durable started/completed receipts on the tape", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-receipts-"));
    writeFileSync(join(cwd, "app.ts"), "export const v = 1;\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });
    writeFileSync(join(cwd, "app.ts"), "export const v = 2;\n", "utf8");

    const result = runtime.ops.session.rewind.rewind(SESSION_ID, { mode: "both" });
    expect(result.ok).toBe(true);

    const started = runtime.ops.events.records
      .query(SESSION_ID, { type: "rollback.started" })
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.method === "world_restore");
    expect(started).toHaveLength(1);
    expect(String(started[0]?.worldId).startsWith("sha256:")).toBe(true);
    expect(String(started[0]?.fromWorldId).startsWith("sha256:")).toBe(true);

    const completed = runtime.ops.events.records
      .query(SESSION_ID, { type: "session.rewind.completed" })
      .map((event) => event.payload as Record<string, unknown>);
    expect(completed).toHaveLength(1);
    const worldRestore = completed[0]?.worldRestore as Record<string, unknown> | undefined;
    expect(worldRestore?.worldId).toBe(started[0]?.worldId);
  });

  test("falls back to the patch lane when the captured world is gone", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-fallback-"));
    writeFileSync(join(cwd, "notes.txt"), "original\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });
    writeFileSync(join(cwd, "notes.txt"), "damaged\n", "utf8");
    rmSync(join(cwd, ".brewva", "worlds"), { recursive: true, force: true });

    const result = runtime.ops.session.rewind.rewind(SESSION_ID, { mode: "both" });
    // The empty patch window succeeds, but no world restore happened: the
    // damage stays — exactly the honest pre-world behavior.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected fallback rewind ok");
    expect(Object.keys(result)).not.toContain("worldRestore");
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("damaged\n");
  });

  test("degraded-artifact drill: world lane supersedes covered patches where the patch lane would refuse", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-drill-"));
    writeFileSync(join(cwd, "notes.txt"), "original\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    // Two applied patch sets land after the checkpoint with NO rollback
    // artifacts on disk — the patch lane would refuse this window outright
    // (rollback_artifact_missing). One touched only captured scope; the other
    // also wrote an excluded path whose mutation a world restore cannot revert.
    runtime.ops.tools.sourcePatch.plans.apply(SESSION_ID, {
      ok: true,
      planId: "plan-covered",
      patchSetId: "p-covered",
      appliedPaths: ["notes.txt"],
      failedPaths: [],
    });
    runtime.ops.tools.sourcePatch.plans.apply(SESSION_ID, {
      ok: true,
      planId: "plan-outside",
      patchSetId: "p-outside",
      appliedPaths: ["node_modules/generated.js"],
      failedPaths: [],
    });
    writeFileSync(join(cwd, "notes.txt"), "damaged\n", "utf8");

    const result = runtime.ops.session.rewind.rewind(SESSION_ID, { mode: "both" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected drill rewind ok");
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("original\n");
    // Only the fully-covered patch is superseded; the out-of-scope one stays
    // applied because its surviving mutation must remain patch-lane reachable.
    expect(result.patchSetIds).toEqual(["p-covered"]);

    const rollbackReceipts = runtime.ops.events.records
      .query(SESSION_ID, { type: "rollback.recorded" })
      .map((event) => event.payload as Record<string, unknown>);
    const superseded = rollbackReceipts.filter(
      (payload) => payload.ok === true && typeof payload.patchSetId === "string",
    );
    expect(superseded.map((payload) => payload.patchSetId)).toEqual(["p-covered"]);
    // The world-level completion receipt (no patchSetId) advances tree-mutation
    // folds and names the out-of-scope survivor.
    const summary = rollbackReceipts.find(
      (payload) =>
        payload.ok === true &&
        payload.method === "world_restore" &&
        payload.patchSetId === undefined,
    );
    expect(summary?.supersededPatchSetIds).toEqual(["p-covered"]);
    expect(summary?.outOfScopePatchSetIds).toEqual(["p-outside"]);

    // Applied-set coherence: downstream folds now see only the survivor.
    const events = runtime.ops.events.records.query(SESSION_ID);
    expect([
      ...deriveAppliedPatchSetIds(events as Parameters<typeof deriveAppliedPatchSetIds>[0]),
    ]).toEqual(["p-outside"]);
  });

  test("rewinding to an already-matching world emits no self-edge restore receipts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-idempotent-"));
    writeFileSync(join(cwd, "notes.txt"), "original\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    // Nothing changed since the checkpoint: the rewind is a provable no-op.
    const result = runtime.ops.session.rewind.rewind(SESSION_ID, { mode: "both" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected idempotent rewind ok");
    expect(result.worldRestore?.wroteFileCount).toBe(0);
    expect(result.worldRestore?.deletedFileCount).toBe(0);
    expect(result.worldRestore?.fromWorldId).toBe(result.worldRestore?.worldId);

    const started = runtime.ops.events.records
      .query(SESSION_ID, { type: "rollback.started" })
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.method === "world_restore");
    expect(started).toHaveLength(0);
  });

  test("preview reports ready through the world lane", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-world-rewind-preview-"));
    writeFileSync(join(cwd, "notes.txt"), "original\n", "utf8");
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    const readiness = runtime.ops.session.rewind.workspaceReadiness(SESSION_ID);
    expect(readiness.world?.status).toBe("available");
    expect(readiness.ready).toBe(true);
    expect(readiness.blockedReason).toBeNull();
  });
});
