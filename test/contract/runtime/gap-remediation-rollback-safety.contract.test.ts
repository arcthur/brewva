import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, VERIFICATION_STATE_RESET_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

function removePatchSnapshot(input: {
  workspace: string;
  sessionId: string;
  path: string;
  snapshotKey: "beforeSnapshotFile" | "afterSnapshotFile";
}): void {
  const snapshotDir = join(input.workspace, ".orchestrator/snapshots", input.sessionId);
  const history = JSON.parse(readFileSync(join(snapshotDir, "patchsets.json"), "utf8")) as {
    patchSets?: Array<{
      changes?: Array<{
        path?: string;
        beforeSnapshotFile?: string;
        afterSnapshotFile?: string;
      }>;
    }>;
  };
  const snapshotFile = history.patchSets
    ?.flatMap((patchSet) => patchSet.changes ?? [])
    .find((change) => change.path === input.path)?.[input.snapshotKey];
  if (!snapshotFile) {
    throw new Error(`Missing ${input.snapshotKey} for ${input.path}`);
  }
  rmSync(join(snapshotDir, snapshotFile), { force: true });
}

describe("Gap remediation: rollback safety net", () => {
  test("tracks file mutations and restores the latest patch set", async () => {
    const workspace = createWorkspace("rollback");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.tools.markCall(sessionId, "edit");
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      channelSuccess: true,
    });

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const verificationResets = runtime.inspect.events.query(sessionId, {
      type: VERIFICATION_STATE_RESET_EVENT_TYPE,
      last: 1,
    });
    expect(verificationResets).toHaveLength(1);
    expect((verificationResets[0]?.payload as { reason?: string } | undefined)?.reason).toBe(
      "rollback",
    );
  });

  test("correction checkpoints undo and redo the full turn patch window", async () => {
    const workspace = createWorkspace("correction-undo-redo");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "correction-undo-redo-1";
    const filePath = join(workspace, "src/correction.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpoint = runtime.authority.correction.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-turn",
      prompt: {
        text: "Change value to 2",
        parts: [],
      },
    });
    expect(checkpoint.status).toBe("active");

    const started = runtime.authority.tools.start({
      sessionId,
      toolCallId: "tool-correction",
      toolName: "edit",
      args: {
        file_path: "src/correction.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });
    expect(started.allowed).toBe(true);
    expect(started.mutationReceipt?.strategy).toBe("workspace_patchset");
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.finish({
      sessionId,
      toolCallId: "tool-correction",
      toolName: "edit",
      args: {
        file_path: "src/correction.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const undo = runtime.authority.correction.undo(sessionId, {
      redoLeafEntryId: "leaf-after-turn",
    });
    expect(undo.ok).toBe(true);
    if (!undo.ok) {
      throw new Error(`Correction undo failed: ${undo.reason}`);
    }
    expect(undo.restoredPrompt?.text).toBe("Change value to 2");
    expect(undo.patchSetIds).toHaveLength(1);
    const rollbackReceiptId = undo.rollbackResults[0]?.mutationReceiptId;
    if (!rollbackReceiptId) {
      throw new Error("Correction undo did not link the rollback mutation receipt");
    }
    expect(undo.reasoningRevert.linkedRollbackReceiptIds).toEqual([rollbackReceiptId]);
    expect(undo.reasoningRevert.linkedRollbackReceiptIds).not.toEqual(undo.patchSetIds);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const undoneState = runtime.inspect.correction.getState(sessionId);
    expect(undoneState.redoAvailable).toBe(true);
    expect(undoneState.nextRedoable?.checkpointId).toBe(checkpoint.checkpointId);
    expect(undoneState.nextRedoable?.redoLeafEntryId).toBe("leaf-after-turn");

    const redo = runtime.authority.correction.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) {
      throw new Error(`Correction redo failed: ${redo.reason}`);
    }
    expect(redo.patchSetIds).toEqual(undo.patchSetIds);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");

    const redoneState = runtime.inspect.correction.getState(sessionId);
    expect(redoneState.undoAvailable).toBe(true);
    expect(redoneState.redoAvailable).toBe(false);
    expect(redoneState.latestUndoable?.checkpointId).toBe(checkpoint.checkpointId);
  });

  test("correction undo compensates successful patch rollbacks when a later rollback fails", async () => {
    const workspace = createWorkspace("correction-undo-compensation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "correction-undo-compensation-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.correction.recordCheckpoint(sessionId, {
      prompt: {
        text: "Change two files",
        parts: [],
      },
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-first",
      toolName: "edit",
      args: { file_path: "src/first.ts" },
    });
    writeFileSync(firstPath, "export const first = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-first",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-second",
      toolName: "edit",
      args: { file_path: "src/second.ts" },
    });
    writeFileSync(secondPath, "export const second = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-second",
      toolName: "edit",
      channelSuccess: true,
    });

    removePatchSnapshot({
      workspace,
      sessionId,
      path: "src/first.ts",
      snapshotKey: "beforeSnapshotFile",
    });

    const undo = runtime.authority.correction.undo(sessionId);
    expect(undo.ok).toBe(false);
    if (undo.ok) {
      throw new Error("Correction undo unexpectedly succeeded");
    }
    expect(undo.reason).toBe("rollback_failed");
    expect(undo.rollbackResults).toHaveLength(2);
    expect(undo.compensationRedoResults).toHaveLength(1);
    expect(undo.compensationRedoResults?.[0]?.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 2;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 2;\n");

    const state = runtime.inspect.correction.getState(sessionId);
    expect(state.undoAvailable).toBe(true);
    expect(state.redoAvailable).toBe(false);
  });

  test("correction redo compensates successful patch replays when a later redo fails", async () => {
    const workspace = createWorkspace("correction-redo-compensation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "correction-redo-compensation-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.correction.recordCheckpoint(sessionId, {
      prompt: {
        text: "Change two files",
        parts: [],
      },
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-first",
      toolName: "edit",
      args: { file_path: "src/first.ts" },
    });
    writeFileSync(firstPath, "export const first = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-first",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-second",
      toolName: "edit",
      args: { file_path: "src/second.ts" },
    });
    writeFileSync(secondPath, "export const second = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-second",
      toolName: "edit",
      channelSuccess: true,
    });

    const undo = runtime.authority.correction.undo(sessionId);
    expect(undo.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");

    removePatchSnapshot({
      workspace,
      sessionId,
      path: "src/second.ts",
      snapshotKey: "afterSnapshotFile",
    });

    const redo = runtime.authority.correction.redo(sessionId);
    expect(redo.ok).toBe(false);
    if (redo.ok) {
      throw new Error("Correction redo unexpectedly succeeded");
    }
    expect(redo.reason).toBe("redo_failed");
    expect(redo.redoResults).toHaveLength(2);
    expect(redo.compensationRollbackResults).toHaveLength(1);
    expect(redo.compensationRollbackResults?.[0]?.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");

    const state = runtime.inspect.correction.getState(sessionId);
    expect(state.undoAvailable).toBe(false);
    expect(state.redoAvailable).toBe(true);
  });

  test("keeps a multi-file patch set applied when rollback cannot restore every file", async () => {
    const workspace = createWorkspace("rollback-multifile-atomic-failure");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-multifile-atomic-failure-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-multifile",
      toolName: "edit",
      args: { files: ["src/first.ts", "src/second.ts"] },
    });
    writeFileSync(firstPath, "export const first = 2;\n", "utf8");
    writeFileSync(secondPath, "export const second = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-multifile",
      toolName: "edit",
      channelSuccess: true,
    });

    removePatchSnapshot({
      workspace,
      sessionId,
      path: "src/first.ts",
      snapshotKey: "beforeSnapshotFile",
    });

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(false);
    if (!rollback.ok) {
      expect(rollback.reason).toBe("restore_failed");
    }
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 2;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 2;\n");
  });

  test("keeps a multi-file patch set undone when redo cannot replay every file", async () => {
    const workspace = createWorkspace("redo-multifile-atomic-failure");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "redo-multifile-atomic-failure-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-multifile",
      toolName: "edit",
      args: { files: ["src/first.ts", "src/second.ts"] },
    });
    writeFileSync(firstPath, "export const first = 2;\n", "utf8");
    writeFileSync(secondPath, "export const second = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-multifile",
      toolName: "edit",
      channelSuccess: true,
    });

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");

    removePatchSnapshot({
      workspace,
      sessionId,
      path: "src/second.ts",
      snapshotKey: "afterSnapshotFile",
    });

    const redo = runtime.authority.tools.redoLastPatchSet(sessionId);
    expect(redo.ok).toBe(false);
    if (!redo.ok) {
      expect(redo.reason).toBe("missing_redo_snapshot");
    }
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");
  });

  test("rolls back added files by deleting them", async () => {
    const workspace = createWorkspace("rollback-add");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-add-1";
    const createdPath = join(workspace, "src/new-file.ts");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      args: { file_path: "src/new-file.ts" },
    });
    writeFileSync(createdPath, "export const created = true;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      channelSuccess: true,
    });

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(existsSync(createdPath)).toBe(false);
  });

  test("returns restore_failed when rollback snapshot is missing", async () => {
    const workspace = createWorkspace("rollback-restore-failed");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-restore-failed-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      channelSuccess: true,
    });

    const snapshotDir = join(workspace, ".orchestrator/snapshots", sessionId);
    for (const entry of readdirSync(snapshotDir)) {
      if (!entry.endsWith(".snap")) continue;
      rmSync(join(snapshotDir, entry), { force: true });
    }

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(false);
    if (!rollback.ok) {
      expect(rollback.reason).toBe("restore_failed");
    }
    expect(rollback.failedPaths).toContain("src/main.ts");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(runtime.inspect.tools.resolveUndoSessionId(sessionId)).toBe(sessionId);
  });

  test("does not track file paths outside workspace during snapshot capture", async () => {
    const workspace = createWorkspace("rollback-path-traversal");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "rollback-path-traversal-1";

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tc-outside",
      toolName: "edit",
      args: { file_path: "../outside.ts" },
    });

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tc-abs",
      toolName: "edit",
      args: { file_path: "/etc/passwd" },
    });

    mkdirSync(join(workspace, "src"), { recursive: true });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tc-inside",
      toolName: "edit",
      args: { file_path: "src/inside.ts" },
    });

    const snapshots = runtime.inspect.events.query(sessionId, { type: "file_snapshot_captured" });
    expect(snapshots).toHaveLength(1);
    const payload = snapshots[0]?.payload as { files?: string[] } | undefined;
    expect(payload?.files).toEqual(["src/inside.ts"]);
  });

  test("supports cross-process undo via persisted patchset history", async () => {
    const workspace = createWorkspace("rollback-persisted");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-persisted-1";
    const filePath = join(workspace, "src/persisted.ts");
    writeFileSync(filePath, "export const persisted = 1;\n", "utf8");

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    runtimeA.maintain.context.onTurnStart(sessionId, 1);
    runtimeA.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      args: { file_path: "src/persisted.ts" },
    });
    writeFileSync(filePath, "export const persisted = 2;\n", "utf8");
    runtimeA.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      channelSuccess: true,
    });

    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const resolved = runtimeB.inspect.tools.resolveUndoSessionId();
    expect(resolved).toBe(sessionId);

    const rollback = runtimeB.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const persisted = 1;\n");
  });
});
