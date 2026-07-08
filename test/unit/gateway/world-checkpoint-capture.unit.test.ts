import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import { createRuntimeConfig } from "../../helpers/runtime.js";

// Coupled world rewind RFC, Phase 1: a rewind checkpoint captures a workspace
// world before the checkpoint event commits (persist-before-reference), the
// block is durable on the checkpoint payload, and the workspace-readiness
// preview reports the world lane honestly — including capture failures and
// post-capture artifact loss. Real filesystem I/O, so the bare 5s default is
// too tight on cold machines.
setDefaultTimeout(60_000);

const SESSION_ID = "world-capture-session";

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "brewva-world-capture-"));
  writeFileSync(join(cwd, "notes.txt"), "hello world lane\n", "utf8");
  return cwd;
}

function worldsEnabledAdapter(cwd: string) {
  const config = createRuntimeConfig((draft) => {
    draft.worlds.enabled = true;
  });
  return createHostedRuntimeAdapter({ cwd, config });
}

function worldsDisabledAdapter(cwd: string) {
  // Worlds are on by default now, so the disabled-path assertions must
  // explicitly opt out rather than rely on the default.
  const config = createRuntimeConfig((draft) => {
    draft.worlds.enabled = false;
  });
  return createHostedRuntimeAdapter({ cwd, config });
}

function readCheckpointPayload(
  runtime: ReturnType<typeof createHostedRuntimeAdapter>,
  sessionId: string,
): Record<string, unknown> {
  const events = runtime.ops.events.records.query(sessionId, {
    type: "session_rewind_checkpoint",
  });
  const payload = events.at(-1)?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function readCheckpointWorldBlock(
  runtime: ReturnType<typeof createHostedRuntimeAdapter>,
  sessionId: string,
): Record<string, unknown> {
  const world = readCheckpointPayload(runtime, sessionId).world;
  return world && typeof world === "object" ? (world as Record<string, unknown>) : {};
}

describe("world checkpoint capture (coupled world rewind RFC, Phase 1)", () => {
  test("stays entirely absent while worlds are disabled", () => {
    const cwd = makeCwd();
    const runtime = worldsDisabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    expect(Object.keys(readCheckpointPayload(runtime, SESSION_ID))).not.toContain("world");
    const readiness = runtime.ops.session.rewind.workspaceReadiness(SESSION_ID);
    expect(Object.keys(readiness)).not.toContain("world");
    expect(existsSync(join(cwd, ".brewva", "worlds"))).toBe(false);
  });

  test("captures with the default config (worlds are on by default)", () => {
    const cwd = makeCwd();
    // No explicit config: pins that the shipped default now captures worlds.
    const runtime = createHostedRuntimeAdapter({ cwd });
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    const block = readCheckpointWorldBlock(runtime, SESSION_ID);
    expect(String(block.id).startsWith("sha256:")).toBe(true);
    expect(runtime.ops.session.rewind.workspaceReadiness(SESSION_ID).world?.status).toBe(
      "available",
    );
  });

  test("captures a world before the checkpoint commits and previews it as available", () => {
    const cwd = makeCwd();
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    const block = readCheckpointWorldBlock(runtime, SESSION_ID);
    expect(typeof block.id).toBe("string");
    expect(String(block.id).startsWith("sha256:")).toBe(true);
    expect(Object.keys(block)).not.toContain("error");
    expect(existsSync(join(cwd, ".brewva", "worlds", "manifests"))).toBe(true);

    const readiness = runtime.ops.session.rewind.workspaceReadiness(SESSION_ID);
    expect(readiness.world?.status).toBe("available");
    expect(readiness.world?.worldId).toBe(String(block.id));
  });

  test("reports missing artifacts when the store loses the captured world", () => {
    const cwd = makeCwd();
    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });
    rmSync(join(cwd, ".brewva", "worlds", "manifests"), { recursive: true, force: true });

    const readiness = runtime.ops.session.rewind.workspaceReadiness(SESSION_ID);
    expect(readiness.world?.status).toBe("missing_artifacts");
    expect(typeof readiness.world?.worldId).toBe("string");
  });

  test("records a durable capture failure without blocking the checkpoint", () => {
    const cwd = makeCwd();
    // Occupy the store path with a file so every store write fails.
    mkdirSync(join(cwd, ".brewva"), { recursive: true });
    writeFileSync(join(cwd, ".brewva", "worlds"), "not a directory", "utf8");

    const runtime = worldsEnabledAdapter(cwd);
    runtime.ops.session.rewind.recordCheckpoint(SESSION_ID, { leafEntryId: "leaf-1" });

    const block = readCheckpointWorldBlock(runtime, SESSION_ID);
    expect(typeof block.error).toBe("string");

    const state = runtime.ops.session.rewind.getState(SESSION_ID);
    expect(state.rewindAvailable).toBe(true);

    const readiness = runtime.ops.session.rewind.workspaceReadiness(SESSION_ID);
    expect(readiness.world?.status).toBe("capture_failed");
  });
});
