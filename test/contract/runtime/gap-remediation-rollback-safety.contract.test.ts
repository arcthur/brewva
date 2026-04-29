import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
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

function expectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload");
  }
  return value as Record<string, unknown>;
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

  test("session rewind checkpoints undo and redo the full turn patch window", async () => {
    const workspace = createWorkspace("session-rewind-undo-redo");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "session-rewind-undo-redo-1";
    const filePath = join(workspace, "src/session-rewind.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before-turn",
      prompt: {
        text: "Change value to 2",
        parts: [],
      },
    });
    expect(checkpoint.status).toBe("active");

    const started = runtime.authority.tools.start({
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
    runtime.authority.tools.finish({
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

    const undo = runtime.authority.session.rewind(sessionId, {
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

    const undoneState = runtime.inspect.session.getRewindState(sessionId);
    expect(undoneState.redoAvailable).toBe(true);
    expect(undoneState.nextRedoable?.checkpointId).toBe(checkpoint.checkpointId);
    expect(undoneState.nextRedoable?.returnLeafEntryId).toBe("leaf-after-turn");

    const redo = runtime.authority.session.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) {
      throw new Error(`Session redo failed: ${redo.reason}`);
    }
    expect(redo.patchSetIds).toEqual(undo.patchSetIds);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");

    const redoneState = runtime.inspect.session.getRewindState(sessionId);
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      prompt: { text: "Change value while streaming", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-streaming-edit",
      toolName: "edit",
      args: { file_path: "src/streaming.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-streaming-edit",
      toolName: "edit",
      channelSuccess: true,
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "tool_execution_start",
      payload: {
        toolCallId: "streaming-tool",
        toolName: "read",
      },
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId).execution.kind).toBe("tool_executing");

    const rewind = runtime.authority.session.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });

    expect(rewind.ok).toBe(false);
    if (rewind.ok) {
      throw new Error("Streaming rewind unexpectedly succeeded");
    }
    expect(rewind.reason).toBe("streaming");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(runtime.inspect.session.getRewindState(sessionId).redoAvailable).toBe(false);
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });

    const bothSessionId = "rewind-governance-both";
    const bothFilePath = join(workspace, "src/governance-both.ts");
    writeFileSync(bothFilePath, "export const value = 1;\n", "utf8");
    runtime.maintain.context.onTurnStart(bothSessionId, 1);
    runtime.authority.session.recordRewindCheckpoint(bothSessionId, {
      prompt: { text: "Change value with workspace gate", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId: bothSessionId,
      toolCallId: "tool-governance-both",
      toolName: "edit",
      args: { file_path: "src/governance-both.ts" },
    });
    writeFileSync(bothFilePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId: bothSessionId,
      toolCallId: "tool-governance-both",
      toolName: "edit",
      channelSuccess: true,
    });

    const blocked = runtime.authority.session.rewind(bothSessionId, {
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
    runtime.maintain.context.onTurnStart(conversationSessionId, 1);
    runtime.authority.session.recordRewindCheckpoint(conversationSessionId, {
      prompt: { text: "Change value with conversation gate", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId: conversationSessionId,
      toolCallId: "tool-governance-conversation",
      toolName: "edit",
      args: { file_path: "src/governance-conversation.ts" },
    });
    writeFileSync(conversationFilePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId: conversationSessionId,
      toolCallId: "tool-governance-conversation",
      toolName: "edit",
      channelSuccess: true,
    });

    const allowed = runtime.authority.session.rewind(conversationSessionId, {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    const firstCheckpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before-first",
      prompt: { text: "Set value to 2", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-first",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-first",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.maintain.context.onTurnStart(sessionId, 2);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before-second",
      prompt: { text: "Set value to 3", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-second",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 3;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-second",
      toolName: "edit",
      channelSuccess: true,
    });

    const firstRewind = runtime.authority.session.rewind(sessionId, {
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

    runtime.maintain.context.onTurnStart(sessionId, 3);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before-third",
      prompt: { text: "Set value to 4", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-lineage-third",
      toolName: "edit",
      args: { file_path: "src/lineage.ts" },
    });
    writeFileSync(filePath, "export const value = 4;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-lineage-third",
      toolName: "edit",
      channelSuccess: true,
    });

    const secondRewind = runtime.authority.session.rewind(sessionId, {
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

  test("replayed rewind and redo events hydrate reasoning records from receipt ids", async () => {
    const workspace = createWorkspace("rewind-replay-reasoning-payload");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-replay-reasoning-payload-1";
    const filePath = join(workspace, "src/replay.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    const checkpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before-replay",
      prompt: { text: "Change value for replay", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-replay",
      toolName: "edit",
      args: { file_path: "src/replay.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-replay",
      toolName: "edit",
      channelSuccess: true,
    });

    const rewind = runtime.authority.session.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "both",
      summary: "carry",
      returnLeafEntryId: "leaf-after-rewind",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok || !rewind.reasoningRevert) {
      throw new Error("Expected rewind to record a reasoning revert");
    }
    const rewindEvent = runtime.inspect.events.query(sessionId, {
      type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
      last: 1,
    })[0];
    const rewindPayload = expectRecord(rewindEvent?.payload);
    expect(rewindPayload.reasoningRevert).toBeUndefined();
    expect(rewindPayload.reasoningRevertId).toBe(rewind.reasoningRevert.revertId);
    expect(rewindPayload.reasoningRevertEventId).toBe(rewind.reasoningRevert.eventId);

    const reloadedAfterRewind = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    expect(
      reloadedAfterRewind.inspect.session.getRewindState(sessionId).latestRewind?.reasoningRevert
        ?.revertId,
    ).toBe(rewind.reasoningRevert.revertId);

    const redo = runtime.authority.session.redo(sessionId, {
      returnLeafEntryId: "leaf-after-redo",
    });
    expect(redo.ok).toBe(true);
    if (!redo.ok || !redo.reasoningCheckpoint) {
      throw new Error("Expected redo to record a reasoning checkpoint");
    }
    const redoEvent = runtime.inspect.events.query(sessionId, {
      type: SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
      last: 1,
    })[0];
    const redoPayload = expectRecord(redoEvent?.payload);
    expect(redoPayload.reasoningCheckpoint).toBeUndefined();
    expect(redoPayload.reasoningCheckpointId).toBe(redo.reasoningCheckpoint.checkpointId);
    expect(redoPayload.reasoningCheckpointEventId).toBe(redo.reasoningCheckpoint.eventId);

    const reloadedAfterRedo = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const replayedCheckpoint = reloadedAfterRedo.inspect.session
      .getRewindState(sessionId)
      .checkpoints.find((entry) => entry.checkpointId === checkpoint.checkpointId);
    expect(replayedCheckpoint?.patchSetIds).toEqual(rewind.patchSetIds);
    expect(replayedCheckpoint?.status).toBe("redone");
  });

  test("code-mode rewind rolls back patch sets without changing reasoning lineage", async () => {
    const workspace = createWorkspace("rewind-code-mode");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-code-mode-1";
    const filePath = join(workspace, "src/code-mode.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-code-before",
      prompt: {
        text: "Change value to 2",
        parts: [],
      },
    });
    const reasoningBefore = runtime.inspect.reasoning.getActiveState(sessionId);

    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-code-mode",
      toolName: "edit",
      args: { file_path: "src/code-mode.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-code-mode",
      toolName: "edit",
      channelSuccess: true,
    });

    const rewind = runtime.authority.session.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "code",
      summary: "none",
      returnLeafEntryId: "leaf-code-after",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok) {
      throw new Error(`Code-mode rewind failed: ${rewind.reason}`);
    }
    expect(rewind.reasoningRevert).toBeUndefined();
    expect(rewind.divergenceNote).toMatchObject({
      kind: "conversation_ahead",
      patchSetCount: 1,
    });
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const reasoningAfter = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(reasoningAfter.activeCheckpointId).toBe(reasoningBefore.activeCheckpointId);
    expect(reasoningAfter.latestRevert?.eventId).toBe(reasoningBefore.latestRevert?.eventId);

    const rewindState = runtime.inspect.session.getRewindState(sessionId);
    expect(rewindState.latestRewind).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      mode: "code",
      summary: "none",
      divergenceNote: {
        kind: "conversation_ahead",
      },
    });

    const redo = runtime.authority.session.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) {
      throw new Error(`Code-mode redo failed: ${redo.reason}`);
    }
    expect(redo.reasoningCheckpoint).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("default undo skips checkpoints already sitting in the redo stack", async () => {
    const workspace = createWorkspace("rewind-skip-undone-checkpoint");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-skip-undone-checkpoint-1";
    const filePath = join(workspace, "src/skip.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    const firstCheckpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-1",
      prompt: { text: "Set value to 2", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-skip-1",
      toolName: "edit",
      args: { file_path: "src/skip.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-skip-1",
      toolName: "edit",
      channelSuccess: true,
    });

    runtime.maintain.context.onTurnStart(sessionId, 2);
    const secondCheckpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-2",
      prompt: { text: "Set value to 3", parts: [] },
    });
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-skip-2",
      toolName: "edit",
      args: { file_path: "src/skip.ts" },
    });
    writeFileSync(filePath, "export const value = 3;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-skip-2",
      toolName: "edit",
      channelSuccess: true,
    });

    const firstUndo = runtime.authority.session.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(firstUndo.ok).toBe(true);
    if (!firstUndo.ok) {
      throw new Error(`First undo failed: ${firstUndo.reason}`);
    }
    expect(firstUndo.checkpoint.checkpointId).toBe(secondCheckpoint.checkpointId);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");

    const undoneState = runtime.inspect.session.getRewindState(sessionId);
    expect(undoneState.latestRewindable?.checkpointId).toBe(firstCheckpoint.checkpointId);
    expect(undoneState.nextRedoable?.checkpointId).toBe(secondCheckpoint.checkpointId);

    const secondUndo = runtime.authority.session.rewind(sessionId, {
      mode: "both",
      summary: "carry",
    });
    expect(secondUndo.ok).toBe(true);
    if (!secondUndo.ok) {
      throw new Error(`Second undo failed: ${secondUndo.reason}`);
    }
    expect(secondUndo.checkpoint.checkpointId).toBe(firstCheckpoint.checkpointId);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const stackedState = runtime.inspect.session.getRewindState(sessionId);
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
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.maintain.context.onTurnStart(sessionId, 1);
    const checkpoint = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-before",
      prompt: { text: "Prepare a branch", parts: [] },
    });

    const rewind = runtime.authority.session.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "both",
      summary: "carry",
      returnLeafEntryId: "leaf-after",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok) {
      throw new Error(`Rewind failed: ${rewind.reason}`);
    }

    runtime.maintain.context.onTurnStart(sessionId, 2);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: "leaf-next",
      prompt: { text: "Continue from the rewound branch", parts: [] },
    });

    const rewoundCheckpoint = runtime.inspect.session
      .getRewindState(sessionId)
      .checkpoints.find((entry) => entry.checkpointId === checkpoint.checkpointId);
    expect(rewoundCheckpoint).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      status: "active",
    });
    expect(rewoundCheckpoint?.supersededAt).toBeUndefined();
    expect(rewoundCheckpoint?.supersededByEventId).toBeUndefined();
  });

  test("session undo compensates successful patch rollbacks when a later rollback fails", async () => {
    const workspace = createWorkspace("session-rewind-undo-compensation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "session-rewind-undo-compensation-1";
    const firstPath = join(workspace, "src/first.ts");
    const secondPath = join(workspace, "src/second.ts");
    writeFileSync(firstPath, "export const first = 1;\n", "utf8");
    writeFileSync(secondPath, "export const second = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
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

    removePatchSnapshot({
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
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

    removePatchSnapshot({
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
