import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionStore } from "../../packages/brewva-runtime/src/projection/store.js";
import type { ProjectionUnitCandidate } from "../../packages/brewva-runtime/src/projection/types.js";

function candidate(input: {
  sessionId?: string;
  projectionKey: string;
  label: string;
  statement: string;
  metadata?: ProjectionUnitCandidate["metadata"];
}): ProjectionUnitCandidate {
  const sessionId = input.sessionId ?? "projection-store-session";
  return {
    sessionId,
    status: "active",
    projectionKey: input.projectionKey,
    label: input.label,
    statement: input.statement,
    metadata: input.metadata,
    sourceRefs: [
      {
        eventId: `evt-${input.projectionKey}`,
        eventType: "task_event",
        sessionId,
        timestamp: Date.now(),
      },
    ],
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

describe("projection store", () => {
  test("upsert deduplicates by session + fingerprint", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-dedupe-"));
    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });

    const first = store.upsertUnit(
      candidate({
        projectionKey: "truth_fact:verification:1",
        label: "truth.verification_failed",
        statement: "verification requires attention",
      }),
    );
    const second = store.upsertUnit(
      candidate({
        projectionKey: "truth_fact:verification:1",
        label: "truth.verification_failed",
        statement: "verification requires attention",
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(store.listUnits("projection-store-session")).toHaveLength(1);
  });

  test("resolveUnits supports truth_fact directives", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-resolve-"));
    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });

    const verification = store.upsertUnit(
      candidate({
        projectionKey: "truth_fact:verification:1",
        label: "truth.verification_failed",
        statement: "verification requires attention",
        metadata: {
          truthFactId: "truth:verification:1",
        },
      }),
    ).unit;

    const resolved = store.resolveUnits({
      sessionId: "projection-store-session",
      sourceType: "truth_fact",
      sourceId: "truth:verification:1",
      resolvedAt: Date.now(),
    });

    expect(resolved).toBe(1);
    expect(
      store.listUnits("projection-store-session").find((unit) => unit.id === verification.id)
        ?.status,
    ).toBe("resolved");
  });

  test("resolveUnits supports replacing a projection group while keeping current keys", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-group-resolve-"));
    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });

    store.upsertUnit(
      candidate({
        projectionKey: "task_spec.goal",
        label: "task.goal",
        statement: "Ship governance kernel runtime",
        metadata: {
          projectionGroup: "task_spec",
        },
      }),
    );
    const staleConstraint = store.upsertUnit(
      candidate({
        projectionKey: "task_spec.constraint:no backward compatibility.",
        label: "task.constraint",
        statement: "No backward compatibility.",
        metadata: {
          projectionGroup: "task_spec",
        },
      }),
    ).unit;

    const resolved = store.resolveUnits({
      sessionId: "projection-store-session",
      sourceType: "projection_group",
      groupKey: "task_spec",
      keepProjectionKeys: ["task_spec.goal"],
      resolvedAt: Date.now(),
    });

    expect(resolved).toBe(1);
    expect(
      store.listUnits("projection-store-session").find((unit) => unit.id === staleConstraint.id)
        ?.status,
    ).toBe("resolved");
  });

  test("stores working snapshots on disk per session and clears only in-memory cache", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-working-"));
    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });

    store.setWorkingSnapshot({
      sessionId: "projection-store-session",
      generatedAt: Date.now(),
      sourceUnitIds: ["u1"],
      entries: [
        {
          unitId: "u1",
          label: "task.goal",
          statement: "current state",
          updatedAt: Date.now(),
          sourceRefs: [],
        },
      ],
      content: "[WorkingProjection]\n- task.goal: current state",
    });
    store.setWorkingSnapshot({
      sessionId: "projection-store-session-b",
      generatedAt: Date.now(),
      sourceUnitIds: ["u2"],
      entries: [
        {
          unitId: "u2",
          label: "task.goal",
          statement: "another state",
          updatedAt: Date.now(),
          sourceRefs: [],
        },
      ],
      content: "[WorkingProjection]\n- task.goal: another state",
    });

    expect(store.getWorkingSnapshot("projection-store-session")).toBeDefined();
    expect(store.getWorkingSnapshot("projection-store-session-b")).toBeDefined();
    const sessionAPath = workingSnapshotPath(rootDir, "projection-store-session");
    const sessionBPath = workingSnapshotPath(rootDir, "projection-store-session-b");
    expect(existsSync(sessionAPath)).toBe(true);
    expect(existsSync(sessionBPath)).toBe(true);
    expect(readFileSync(sessionAPath, "utf8")).toContain("current state");
    expect(readFileSync(sessionBPath, "utf8")).toContain("another state");

    store.clearWorkingSnapshot("projection-store-session");
    expect(store.getWorkingSnapshot("projection-store-session")).toBeUndefined();
    expect(store.getWorkingSnapshot("projection-store-session-b")).toBeDefined();
    expect(existsSync(sessionAPath)).toBe(true);
  });

  test("appends projection unit rows without rereading the existing log", () => {
    if (process.platform === "win32") {
      return;
    }

    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-append-only-"));
    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });

    store.upsertUnit(
      candidate({
        projectionKey: "task_spec.goal",
        label: "task.goal",
        statement: "append-only baseline",
      }),
    );

    const unitsPath = join(rootDir, "units.jsonl");
    chmodSync(unitsPath, 0o200);
    try {
      const updated = store.upsertUnit(
        candidate({
          projectionKey: "task_spec.goal",
          label: "task.goal",
          statement: "append-only update",
        }),
      );

      expect(updated.created).toBe(false);
      expect(store.listUnits("projection-store-session")).toHaveLength(1);
      chmodSync(unitsPath, 0o600);
      expect(readFileSync(unitsPath, "utf8")).toContain("append-only update");
    } finally {
      chmodSync(unitsPath, 0o600);
    }
  });

  test("purges incompatible on-disk units when removed unit types are encountered", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-projection-store-legacy-"));
    const unitsPath = join(rootDir, "units.jsonl");
    writeFileSync(
      unitsPath,
      `${JSON.stringify({
        id: "legacy-1",
        sessionId: "legacy-session",
        type: "learning",
        status: "active",
        topic: "legacy",
        statement: "legacy cognitive unit",
        fingerprint: "fp-legacy-1",
        sourceRefs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
      })}\n`,
      "utf8",
    );

    const store = new ProjectionStore({
      rootDir,
      workingFile: "working.md",
    });
    expect(store.listUnits("legacy-session")).toHaveLength(0);
    expect(readFileSync(unitsPath, "utf8")).toBe("");
    expect(existsSync(join(rootDir, "state.json"))).toBe(true);
  });
});
