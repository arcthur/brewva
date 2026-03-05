import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, TASK_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime";

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

describe("memory engine", () => {
  test("publishes working projection when memory events are ingested", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-"));
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-1",
        sessionId: "memory-engine-session",
        goal: "Ship governance projection",
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId: "memory-engine-session",
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.content.includes("[WorkingMemory]")).toBe(true);
    expect(snapshot?.content.includes("Ship governance projection")).toBe(true);

    const workingPath = join(workspace, "working.md");
    expect(existsSync(workingPath)).toBe(true);
    expect(readFileSync(workingPath, "utf8").includes("[WorkingMemory]")).toBe(true);
  });

  test("rebuildSessionFromTape honors missing_only semantics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-rebuild-"));
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    const sessionId = "memory-engine-rebuild";
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
});
