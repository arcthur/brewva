import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { VERIFICATION_STATE_RESET_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  removeRuntimeContractPatchSnapshot,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("tool patchset rollback", () => {
  test("tracks file mutations and restores the latest patch set", async () => {
    const workspace = createWorkspace("rollback");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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

  test("keeps a multi-file patch set applied when rollback cannot restore every file", async () => {
    const workspace = createWorkspace("rollback-multifile-atomic-failure");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-multifile-atomic-failure-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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

    removeRuntimeContractPatchSnapshot({
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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

    removeRuntimeContractPatchSnapshot({
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
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
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
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    });
    const resolved = runtimeB.inspect.tools.resolveUndoSessionId();
    expect(resolved).toBe(sessionId);

    const rollback = runtimeB.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const persisted = 1;\n");
  });
});
