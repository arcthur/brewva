import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  removeRuntimeContractPatchSnapshot,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("session rewind compensation", () => {
  test("session undo compensates successful patch rollbacks when a later rollback fails", async () => {
    const workspace = createWorkspace("session-rewind-undo-compensation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "session-rewind-undo-compensation-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
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

    removeRuntimeContractPatchSnapshot({
      workspace,
      sessionId,
      path: "src/first.ts",
      snapshotKey: "beforeSnapshotFile",
    });

    const undo = runtime.authority.session.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(undo.ok).toBe(false);
    if (undo.ok) {
      throw new Error("Session undo unexpectedly succeeded");
    }
    expect(undo.reason).toBe("rollback_failed");
    expect(undo.rollbackResults).toHaveLength(2);
    expect(undo.compensationRedoResults).toHaveLength(1);
    expect(undo.compensationRedoResults?.[0]?.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 2;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 2;\n");

    const state = runtime.inspect.session.getRewindState(sessionId);
    expect(state.rewindAvailable).toBe(true);
    expect(state.redoAvailable).toBe(false);
  });

  test("session redo compensates successful patch replays when a later redo fails", async () => {
    const workspace = createWorkspace("session-rewind-redo-compensation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "session-rewind-redo-compensation-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
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

    const undo = runtime.authority.session.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(undo.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");

    removeRuntimeContractPatchSnapshot({
      workspace,
      sessionId,
      path: "src/second.ts",
      snapshotKey: "afterSnapshotFile",
    });

    const redo = runtime.authority.session.redo(sessionId);
    expect(redo.ok).toBe(false);
    if (redo.ok) {
      throw new Error("Session redo unexpectedly succeeded");
    }
    expect(redo.reason).toBe("redo_failed");
    expect(redo.redoResults).toHaveLength(2);
    expect(redo.compensationRollbackResults).toHaveLength(1);
    expect(redo.compensationRollbackResults?.[0]?.ok).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(secondPath, "utf8")).toBe("export const second = 1;\n");

    const state = runtime.inspect.session.getRewindState(sessionId);
    expect(state.rewindAvailable).toBe(false);
    expect(state.redoAvailable).toBe(true);
  });
});
