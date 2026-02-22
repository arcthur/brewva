import { describe, expect } from "bun:test";
import {
  cleanupWorkspace,
  createWorkspace,
  runCliSync,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: cli exit codes", () => {
  runLive("returns non-zero exit code for unknown flags", () => {
    const workspace = createWorkspace("cli-unknown-flag");
    writeMinimalConfig(workspace);
    try {
      const run = runCliSync(workspace, ["--invalid-flag"]);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(run.stderr.includes("Unknown option")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("returns non-zero exit code for --undo/--replay conflict", () => {
    const workspace = createWorkspace("cli-undo-replay-conflict");
    writeMinimalConfig(workspace);
    try {
      const run = runCliSync(workspace, ["--undo", "--replay"]);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(run.stderr.includes("--undo cannot be combined with --replay")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("returns non-zero exit code for --replay with task flags", () => {
    const workspace = createWorkspace("cli-replay-task-conflict");
    writeMinimalConfig(workspace);
    try {
      const run = runCliSync(workspace, [
        "--replay",
        "--task",
        '{"schema":"brewva.task.v1","goal":"x"}',
      ]);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(
        run.stderr.includes("--undo/--replay cannot be combined with --task/--task-file"),
      ).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
