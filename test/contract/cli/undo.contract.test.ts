import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { assertCliSuccess, runCliSync } from "../../helpers/cli.js";
import { patchDateNow } from "../../helpers/global-state.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("cli contract: undo", () => {
  test("undo and redo restore the latest correction checkpoint through the CLI surface", () => {
    const workspace = createTestWorkspace("contract-undo");
    const filePath = join(workspace, "undo_fixture.txt");
    const baseline = "BASELINE\n";
    const changed = "CHANGED\n";
    writeFileSync(filePath, baseline, "utf8");

    try {
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionId = "system-undo-session";
      runtime.maintain.context.onTurnStart(sessionId, 1);
      runtime.authority.correction.recordCheckpoint(sessionId, {
        turnId: "turn-1",
        prompt: {
          text: "Change undo_fixture.txt",
          parts: [{ type: "text", text: "Change undo_fixture.txt" }],
        },
      });
      runtime.authority.tools.trackCallStart({
        sessionId,
        toolCallId: "tc-edit",
        toolName: "edit",
        args: { file_path: "undo_fixture.txt" },
      });
      writeFileSync(filePath, changed, "utf8");
      runtime.authority.tools.trackCallEnd({
        sessionId,
        toolCallId: "tc-edit",
        toolName: "edit",
        channelSuccess: true,
      });

      const undo = runCliSync(workspace, ["--undo", "--session", sessionId]);
      assertCliSuccess(undo, "system-undo");
      expect(undo.stdout).toContain("Correction undo applied");
      expect(undo.stdout).toContain("Restored prompt: Change undo_fixture.txt");
      expect(readFileSync(filePath, "utf8")).toBe(baseline);

      const redo = runCliSync(workspace, ["--redo", "--session", sessionId]);
      assertCliSuccess(redo, "system-redo");
      expect(redo.stdout).toContain("Correction redo applied");
      expect(readFileSync(filePath, "utf8")).toBe(changed);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("redo without explicit session resolves a redoable correction checkpoint", () => {
    const workspace = createTestWorkspace("contract-redo-auto");
    const undoOnlyFilePath = join(workspace, "undo_only.txt");
    const redoFilePath = join(workspace, "redo_fixture.txt");
    writeFileSync(undoOnlyFilePath, "UNDO_BASELINE\n", "utf8");
    writeFileSync(redoFilePath, "REDO_BASELINE\n", "utf8");

    try {
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const undoOnlySessionId = "system-undo-only-session";
      runtime.maintain.context.onTurnStart(undoOnlySessionId, 1);
      runtime.authority.correction.recordCheckpoint(undoOnlySessionId, {
        turnId: "turn-undo-only",
        prompt: {
          text: "Change undo_only.txt",
          parts: [{ type: "text", text: "Change undo_only.txt" }],
        },
      });
      runtime.authority.tools.trackCallStart({
        sessionId: undoOnlySessionId,
        toolCallId: "tc-undo-only-edit",
        toolName: "edit",
        args: { file_path: "undo_only.txt" },
      });
      writeFileSync(undoOnlyFilePath, "UNDO_CHANGED\n", "utf8");
      runtime.authority.tools.trackCallEnd({
        sessionId: undoOnlySessionId,
        toolCallId: "tc-undo-only-edit",
        toolName: "edit",
        channelSuccess: true,
      });

      const redoSessionId = "system-redo-session";
      runtime.maintain.context.onTurnStart(redoSessionId, 1);
      runtime.authority.correction.recordCheckpoint(redoSessionId, {
        turnId: "turn-redo",
        prompt: {
          text: "Change redo_fixture.txt",
          parts: [{ type: "text", text: "Change redo_fixture.txt" }],
        },
      });
      runtime.authority.tools.trackCallStart({
        sessionId: redoSessionId,
        toolCallId: "tc-redo-edit",
        toolName: "edit",
        args: { file_path: "redo_fixture.txt" },
      });
      writeFileSync(redoFilePath, "REDO_CHANGED\n", "utf8");
      runtime.authority.tools.trackCallEnd({
        sessionId: redoSessionId,
        toolCallId: "tc-redo-edit",
        toolName: "edit",
        channelSuccess: true,
      });
      const undo = runtime.authority.correction.undo(redoSessionId);
      expect(undo.ok).toBe(true);
      expect(readFileSync(redoFilePath, "utf8")).toBe("REDO_BASELINE\n");

      const redo = runCliSync(workspace, ["--redo"]);
      assertCliSuccess(redo, "system-redo-auto");
      expect(redo.stdout).toContain(`Correction redo applied in session ${redoSessionId}`);
      expect(readFileSync(redoFilePath, "utf8")).toBe("REDO_CHANGED\n");
      expect(readFileSync(undoOnlyFilePath, "utf8")).toBe("UNDO_CHANGED\n");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("redo without explicit session prefers the most recently undone checkpoint", () => {
    const workspace = createTestWorkspace("contract-redo-auto-recent-undo");
    const olderCheckpointFilePath = join(workspace, "older_checkpoint.txt");
    const newerCheckpointFilePath = join(workspace, "newer_checkpoint.txt");
    writeFileSync(olderCheckpointFilePath, "OLDER_BASELINE\n", "utf8");
    writeFileSync(newerCheckpointFilePath, "NEWER_BASELINE\n", "utf8");

    let now = 1_710_000_000_000;
    const restoreDateNow = patchDateNow(() => now);
    try {
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const olderCheckpointSessionId = "system-older-checkpoint-session";
      now = 1_710_000_000_100;
      runtime.maintain.context.onTurnStart(olderCheckpointSessionId, 1);
      runtime.authority.correction.recordCheckpoint(olderCheckpointSessionId, {
        turnId: "turn-older-checkpoint",
        prompt: {
          text: "Change older_checkpoint.txt",
          parts: [{ type: "text", text: "Change older_checkpoint.txt" }],
        },
      });
      runtime.authority.tools.trackCallStart({
        sessionId: olderCheckpointSessionId,
        toolCallId: "tc-older-edit",
        toolName: "edit",
        args: { file_path: "older_checkpoint.txt" },
      });
      writeFileSync(olderCheckpointFilePath, "OLDER_CHANGED\n", "utf8");
      runtime.authority.tools.trackCallEnd({
        sessionId: olderCheckpointSessionId,
        toolCallId: "tc-older-edit",
        toolName: "edit",
        channelSuccess: true,
      });

      const newerCheckpointSessionId = "system-newer-checkpoint-session";
      now = 1_710_000_000_200;
      runtime.maintain.context.onTurnStart(newerCheckpointSessionId, 1);
      runtime.authority.correction.recordCheckpoint(newerCheckpointSessionId, {
        turnId: "turn-newer-checkpoint",
        prompt: {
          text: "Change newer_checkpoint.txt",
          parts: [{ type: "text", text: "Change newer_checkpoint.txt" }],
        },
      });
      runtime.authority.tools.trackCallStart({
        sessionId: newerCheckpointSessionId,
        toolCallId: "tc-newer-edit",
        toolName: "edit",
        args: { file_path: "newer_checkpoint.txt" },
      });
      writeFileSync(newerCheckpointFilePath, "NEWER_CHANGED\n", "utf8");
      runtime.authority.tools.trackCallEnd({
        sessionId: newerCheckpointSessionId,
        toolCallId: "tc-newer-edit",
        toolName: "edit",
        channelSuccess: true,
      });

      now = 1_710_000_000_300;
      const newerUndo = runtime.authority.correction.undo(newerCheckpointSessionId);
      expect(newerUndo.ok).toBe(true);
      now = 1_710_000_000_400;
      const olderUndo = runtime.authority.correction.undo(olderCheckpointSessionId);
      expect(olderUndo.ok).toBe(true);

      const redo = runCliSync(workspace, ["--redo"]);
      assertCliSuccess(redo, "system-redo-auto-recent-undo");
      expect(redo.stdout).toContain(
        `Correction redo applied in session ${olderCheckpointSessionId}`,
      );
      expect(readFileSync(olderCheckpointFilePath, "utf8")).toBe("OLDER_CHANGED\n");
      expect(readFileSync(newerCheckpointFilePath, "utf8")).toBe("NEWER_BASELINE\n");
    } finally {
      restoreDateNow();
      cleanupTestWorkspace(workspace);
    }
  });
});
