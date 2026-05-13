import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("session rewind workspace", () => {
  test("session rewind checkpoints undo and redo the full turn patch window", async () => {
    const workspace = createWorkspace("session-rewind-undo-redo");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "session-rewind-undo-redo-1";
    const filePath = join(workspace, "src/session-rewind.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);

    const checkpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-turn",
      prompt: {
        text: "Change value to 2",
        parts: [],
      },
    });
    expect(checkpoint.status).toBe("active");

    const started = runtime.authority.tools.invocation.start({
      sessionId,
      toolCallId: "tool-session-rewind",
      toolName: "edit",
      args: {
        file_path: "src/session-rewind.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });
    expect(started.allowed).toBe(true);
    expect(started.mutationReceipt?.strategy).toBe("workspace_patchset");
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.invocation.finish({
      sessionId,
      toolCallId: "tool-session-rewind",
      toolName: "edit",
      args: {
        file_path: "src/session-rewind.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const undo = runtime.authority.session.rewind.rewind(sessionId, {
      mode: "both",
      summary: "carry",
      returnLeafEntryId: "leaf-after-turn",
    });
    expect(undo.ok).toBe(true);
    if (!undo.ok) {
      throw new Error(`Session undo failed: ${undo.reason}`);
    }
    expect(undo.restoredPrompt?.text).toBe("Change value to 2");
    expect(undo.patchSetIds).toHaveLength(1);
    const rollbackReceiptId = undo.rollbackResults[0]?.mutationReceiptId;
    if (!rollbackReceiptId) {
      throw new Error("Session undo did not link the rollback mutation receipt");
    }
    if (!undo.reasoningRevert) {
      throw new Error("Session undo did not record a reasoning revert");
    }
    expect(undo.reasoningRevert.linkedRollbackReceiptIds).toEqual([rollbackReceiptId]);
    expect(undo.reasoningRevert.linkedRollbackReceiptIds).not.toEqual(undo.patchSetIds);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const undoneState = runtime.inspect.session.rewind.getState(sessionId);
    expect(undoneState.redoAvailable).toBe(true);
    expect(undoneState.nextRedoable?.checkpointId).toBe(checkpoint.checkpointId);
    expect(undoneState.nextRedoable?.returnLeafEntryId).toBe("leaf-after-turn");

    const redo = runtime.authority.session.rewind.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) {
      throw new Error(`Session redo failed: ${redo.reason}`);
    }
    expect(redo.patchSetIds).toEqual(undo.patchSetIds);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");

    const redoneState = runtime.inspect.session.rewind.getState(sessionId);
    expect(redoneState.rewindAvailable).toBe(true);
    expect(redoneState.redoAvailable).toBe(false);
    expect(redoneState.latestRewindable?.checkpointId).toBe(checkpoint.checkpointId);
  });

  test("rewind refuses to mutate reasoning or workspace while the session is streaming", async () => {
    const workspace = createWorkspace("rewind-streaming-guard");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-streaming-guard-1";
    const filePath = join(workspace, "src/streaming.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      prompt: { text: "Change value while streaming", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-streaming-edit",
      toolName: "edit",
      args: { file_path: "src/streaming.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-streaming-edit",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "tool_execution_start",
      payload: {
        toolCallId: "streaming-tool",
        toolName: "read",
      },
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId).execution.kind).toBe("tool_executing");

    const rewind = runtime.authority.session.rewind.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });

    expect(rewind.ok).toBe(false);
    if (rewind.ok) {
      throw new Error("Streaming rewind unexpectedly succeeded");
    }
    expect(rewind.reason).toBe("streaming");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(runtime.inspect.session.rewind.getState(sessionId).redoAvailable).toBe(false);
  });

  test("rewind enforces mode-specific governance before mutating workspace", async () => {
    const workspace = createWorkspace("rewind-governance");
    writeConfig(
      workspace,
      createConfig({
        security: {
          actionAdmissionOverrides: {
            workspace_patch: "deny",
          },
        },
      }),
    );
    mkdirSync(join(workspace, "src"), { recursive: true });

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;

    const bothSessionId = "rewind-governance-both";
    const bothFilePath = join(workspace, "src/governance-both.ts");
    writeFileSync(bothFilePath, "export const value = 1;\n", "utf8");
    runtime.operator.context.lifecycle.onTurnStart(bothSessionId, 1);
    runtime.authority.session.rewind.recordCheckpoint(bothSessionId, {
      prompt: { text: "Change value with workspace gate", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId: bothSessionId,
      toolCallId: "tool-governance-both",
      toolName: "edit",
      args: { file_path: "src/governance-both.ts" },
    });
    writeFileSync(bothFilePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId: bothSessionId,
      toolCallId: "tool-governance-both",
      toolName: "edit",
      channelSuccess: true,
    });

    const blocked = runtime.authority.session.rewind.rewind(bothSessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) {
      throw new Error("Workspace-governed rewind unexpectedly succeeded");
    }
    expect(blocked.reason).toBe("policy_denied");
    expect(readFileSync(bothFilePath, "utf8")).toBe("export const value = 2;\n");

    const conversationSessionId = "rewind-governance-conversation";
    const conversationFilePath = join(workspace, "src/governance-conversation.ts");
    writeFileSync(conversationFilePath, "export const value = 1;\n", "utf8");
    runtime.operator.context.lifecycle.onTurnStart(conversationSessionId, 1);
    runtime.authority.session.rewind.recordCheckpoint(conversationSessionId, {
      prompt: { text: "Change value with conversation gate", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId: conversationSessionId,
      toolCallId: "tool-governance-conversation",
      toolName: "edit",
      args: { file_path: "src/governance-conversation.ts" },
    });
    writeFileSync(conversationFilePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId: conversationSessionId,
      toolCallId: "tool-governance-conversation",
      toolName: "edit",
      channelSuccess: true,
    });

    const allowed = runtime.authority.session.rewind.rewind(conversationSessionId, {
      mode: "conversation",
      summary: "carry",
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) {
      throw new Error(`Conversation-only rewind unexpectedly failed: ${allowed.reason}`);
    }
    expect(readFileSync(conversationFilePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("rewind scopes rollback to the active reasoning lineage after a branch supersedes redo", async () => {
    const workspace = createWorkspace("rewind-active-lineage-patch-scope");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-active-lineage-patch-scope-1";
    const filePath = join(workspace, "src/lineage.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    const firstCheckpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-first",
      prompt: { text: "Set value to 2", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-first",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-first",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 2);
    runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-second",
      prompt: { text: "Set value to 3", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-second",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 3;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-second",
      toolName: "edit",
      channelSuccess: true,
    });

    const firstRewind = runtime.authority.session.rewind.rewind(sessionId, {
      checkpointId: firstCheckpoint.checkpointId,
      mode: "both",
      summary: "none",
      returnLeafEntryId: "leaf-after-first-rewind",
    });
    expect(firstRewind.ok).toBe(true);
    if (!firstRewind.ok) {
      throw new Error(`First lineage rewind failed: ${firstRewind.reason}`);
    }
    expect(firstRewind.patchSetIds).toHaveLength(2);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 3);
    runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-third",
      prompt: { text: "Set value to 4", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-third",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 4;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-third",
      toolName: "edit",
      channelSuccess: true,
    });

    const secondRewind = runtime.authority.session.rewind.rewind(sessionId, {
      checkpointId: firstCheckpoint.checkpointId,
      mode: "both",
      summary: "none",
      returnLeafEntryId: "leaf-after-second-rewind",
    });

    expect(secondRewind.ok).toBe(true);
    if (!secondRewind.ok) {
      throw new Error(`Second lineage rewind failed: ${secondRewind.reason}`);
    }
    expect(secondRewind.patchSetIds).toHaveLength(1);
    expect(
      secondRewind.rollbackResults.map((result) =>
        "reason" in result ? result.reason : undefined,
      ),
    ).not.toContain("patchset_not_latest");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
  });

  test("code-mode rewind rolls back patch sets without changing reasoning lineage", async () => {
    const workspace = createWorkspace("rewind-code-mode");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-code-mode-1";
    const filePath = join(workspace, "src/code-mode.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);

    const checkpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-code-before",
      prompt: {
        text: "Change value to 2",
        parts: [],
      },
    });
    const reasoningBefore = runtime.inspect.reasoning.state.getActive(sessionId);

    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-code-mode",
      toolName: "edit",
      args: { file_path: "src/code-mode.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-code-mode",
      toolName: "edit",
      channelSuccess: true,
    });

    const rewind = runtime.authority.session.rewind.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "code",
      summary: "none",
      returnLeafEntryId: "leaf-code-after",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok) {
      throw new Error(`Code-mode rewind failed: ${rewind.reason}`);
    }
    expect(rewind.reasoningRevert).toBe(undefined);
    expect(rewind.divergenceNote).toMatchObject({
      kind: "conversation_ahead",
      patchSetCount: 1,
    });
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const reasoningAfter = runtime.inspect.reasoning.state.getActive(sessionId);
    expect(reasoningAfter.activeCheckpointId).toBe(reasoningBefore.activeCheckpointId);
    expect(reasoningAfter.latestRevert?.eventId).toBe(reasoningBefore.latestRevert?.eventId);

    const rewindState = runtime.inspect.session.rewind.getState(sessionId);
    expect(rewindState.latestRewind).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      mode: "code",
      summary: "none",
      divergenceNote: {
        kind: "conversation_ahead",
      },
    });

    const redo = runtime.authority.session.rewind.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) {
      throw new Error(`Code-mode redo failed: ${redo.reason}`);
    }
    expect(redo.reasoningCheckpoint).toBe(undefined);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("default undo skips checkpoints already sitting in the redo stack", async () => {
    const workspace = createWorkspace("rewind-skip-undone-checkpoint");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-skip-undone-checkpoint-1";
    const filePath = join(workspace, "src/skip.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    const firstCheckpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-1",
      prompt: { text: "Set value to 2", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-skip-1",
      toolName: "edit",
      args: { file_path: "src/skip.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-skip-1",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 2);
    const secondCheckpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-2",
      prompt: { text: "Set value to 3", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-skip-2",
      toolName: "edit",
      args: { file_path: "src/skip.ts" },
    });
    writeFileSync(filePath, "export const value = 3;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-skip-2",
      toolName: "edit",
      channelSuccess: true,
    });

    const firstUndo = runtime.authority.session.rewind.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(firstUndo.ok).toBe(true);
    if (!firstUndo.ok) {
      throw new Error(`First undo failed: ${firstUndo.reason}`);
    }
    expect(firstUndo.checkpoint.checkpointId).toBe(secondCheckpoint.checkpointId);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");

    const undoneState = runtime.inspect.session.rewind.getState(sessionId);
    expect(undoneState.latestRewindable?.checkpointId).toBe(firstCheckpoint.checkpointId);
    expect(undoneState.nextRedoable?.checkpointId).toBe(secondCheckpoint.checkpointId);

    const secondUndo = runtime.authority.session.rewind.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(secondUndo.ok).toBe(true);
    if (!secondUndo.ok) {
      throw new Error(`Second undo failed: ${secondUndo.reason}`);
    }
    expect(secondUndo.checkpoint.checkpointId).toBe(firstCheckpoint.checkpointId);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const stackedState = runtime.inspect.session.rewind.getState(sessionId);
    expect(stackedState.redoStack.map((entry) => entry.checkpointId)).toEqual([
      secondCheckpoint.checkpointId,
      firstCheckpoint.checkpointId,
    ]);
    expect(stackedState.nextRedoable?.checkpointId).toBe(firstCheckpoint.checkpointId);
  });

  test("active checkpoints do not expose supersede metadata after redo history is cleared", async () => {
    const workspace = createWorkspace("rewind-active-supersede-metadata");
    writeConfig(workspace, createConfig({}));

    const sessionId = "rewind-active-supersede-metadata-1";
    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    const checkpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before",
      prompt: { text: "Prepare a branch", parts: [] },
    });

    const rewind = runtime.authority.session.rewind.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "both",
      summary: "carry",
      returnLeafEntryId: "leaf-after",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok) {
      throw new Error(`Rewind failed: ${rewind.reason}`);
    }

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 2);
    runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-next",
      prompt: { text: "Continue from the rewound branch", parts: [] },
    });

    const rewoundCheckpoint = runtime.inspect.session.rewind
      .getState(sessionId)
      .checkpoints.find((entry) => entry.checkpointId === checkpoint.checkpointId);
    expect(rewoundCheckpoint).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      status: "active",
    });
    expect([rewoundCheckpoint?.supersededAt, rewoundCheckpoint?.supersededByEventId]).toEqual([
      undefined,
      undefined,
    ]);
  });
});
