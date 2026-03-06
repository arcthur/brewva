import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime";
import { ProjectionEngine } from "../../packages/brewva-runtime/src/projection/engine.js";

function taskSpecEvent(input: {
  id: string;
  sessionId: string;
  goal: string;
  turn?: number;
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TASK_EVENT_TYPE,
    turn: input.turn,
    timestamp,
    payload: {
      schema: "brewva.task.ledger.v1",
      kind: "spec_set",
      spec: {
        schema: "brewva.task.v1",
        goal: input.goal,
      },
    },
  };
}

function workingSnapshotPath(
  rootDir: string,
  sessionId: string,
  workingFile = "working.md",
): string {
  return join(
    rootDir,
    "sessions",
    `sess_${Buffer.from(sessionId, "utf8").toString("base64url")}`,
    workingFile,
  );
}

describe("projection engine", () => {
  test("publishes working projection when projection events are ingested", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-"));
    const engine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-1",
        sessionId: "projection-engine-session",
        goal: "Ship governance projection",
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId: "projection-engine-session",
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.content.includes("[WorkingProjection]")).toBe(true);
    expect(snapshot?.content.includes("Ship governance projection")).toBe(true);

    const workingPath = workingSnapshotPath(workspace, "projection-engine-session");
    expect(existsSync(workingPath)).toBe(true);
    expect(readFileSync(workingPath, "utf8").includes("[WorkingProjection]")).toBe(true);
  });

  test("rebuildSessionFromTape honors missing_only semantics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-rebuild-"));
    const engine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    const sessionId = "projection-engine-rebuild";
    const events = [
      taskSpecEvent({
        id: "evt-task-spec-rebuild",
        sessionId,
        goal: "Rebuild projection from tape",
      }),
    ];

    const first = engine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });
    const second = engine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });

    expect(first.reason).toBe("replayed");
    expect(first.replayedEvents).toBe(1);
    expect(second.reason).toBe("already_present");
  });

  test("refresh rebuilds snapshot from persisted units when cache is cold", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-cold-refresh-"));
    const sessionId = "projection-engine-cold-refresh";

    const firstEngine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });
    firstEngine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-cold-refresh",
        sessionId,
        goal: "Rebuild working snapshot from persisted units",
      }),
    );
    firstEngine.refreshIfNeeded({ sessionId });

    rmSync(workingSnapshotPath(workspace, sessionId), { force: true });

    const secondEngine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });
    const rebuilt = secondEngine.refreshIfNeeded({ sessionId });

    expect(rebuilt).toBeDefined();
    expect(rebuilt?.content).toContain("Rebuild working snapshot from persisted units");
    expect(existsSync(workingSnapshotPath(workspace, sessionId))).toBe(true);
  });
});
