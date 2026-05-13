import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

function expectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload");
  }
  return value as Record<string, unknown>;
}

describe("session rewind replay", () => {
  test("replayed rewind and redo events hydrate reasoning records from receipt ids", async () => {
    const workspace = createWorkspace("rewind-replay-reasoning-payload");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rewind-replay-reasoning-payload-1";
    const filePath = join(workspace, "src/replay.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    const checkpoint = runtime.authority.session.rewind.recordCheckpoint(sessionId, {
      leafEntryId: "leaf-before-replay",
      prompt: { text: "Change value for replay", parts: [] },
    });
    runtime.authority.tools.tracking.trackCallStart({
      sessionId,
      toolCallId: "tool-replay",
      toolName: "edit",
      args: { file_path: "src/replay.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "tool-replay",
      toolName: "edit",
      channelSuccess: true,
    });

    const rewind = runtime.authority.session.rewind.rewind(sessionId, {
      checkpointId: checkpoint.checkpointId,
      mode: "both",
      summary: "carry",
      returnLeafEntryId: "leaf-after-rewind",
    });
    expect(rewind.ok).toBe(true);
    if (!rewind.ok || !rewind.reasoningRevert) {
      throw new Error("Expected rewind to record a reasoning revert");
    }
    const rewindEvent = runtime.inspect.events.records.query(sessionId, {
      type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
      last: 1,
    })[0];
    const rewindPayload = expectRecord(rewindEvent?.payload);
    expect(rewindPayload.reasoningRevert).toBe(undefined);
    expect(rewindPayload.reasoningRevertId).toBe(rewind.reasoningRevert.revertId);
    expect(rewindPayload.reasoningRevertEventId).toBe(rewind.reasoningRevert.eventId);

    const reloadedAfterRewind = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    expect(
      reloadedAfterRewind.inspect.session.rewind.getState(sessionId).latestRewind?.reasoningRevert
        ?.revertId,
    ).toBe(rewind.reasoningRevert.revertId);

    const redo = runtime.authority.session.rewind.redo(sessionId, {
      returnLeafEntryId: "leaf-after-redo",
    });
    expect(redo.ok).toBe(true);
    if (!redo.ok || !redo.reasoningCheckpoint) {
      throw new Error("Expected redo to record a reasoning checkpoint");
    }
    const redoEvent = runtime.inspect.events.records.query(sessionId, {
      type: SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
      last: 1,
    })[0];
    const redoPayload = expectRecord(redoEvent?.payload);
    expect(redoPayload.reasoningCheckpoint).toBe(undefined);
    expect(redoPayload.reasoningCheckpointId).toBe(redo.reasoningCheckpoint.checkpointId);
    expect(redoPayload.reasoningCheckpointEventId).toBe(redo.reasoningCheckpoint.eventId);

    const reloadedAfterRedo = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const replayedCheckpoint = reloadedAfterRedo.inspect.session.rewind
      .getState(sessionId)
      .checkpoints.find((entry) => entry.checkpointId === checkpoint.checkpointId);
    expect(replayedCheckpoint?.patchSetIds).toEqual(rewind.patchSetIds);
    expect(replayedCheckpoint?.status).toBe("redone");
  });
});
