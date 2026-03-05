import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type MemoryUnitCandidate } from "@brewva/brewva-runtime";

function candidate(input: {
  sessionId?: string;
  topic: string;
  statement: string;
  metadata?: MemoryUnitCandidate["metadata"];
}): MemoryUnitCandidate {
  const sessionId = input.sessionId ?? "memory-store-session";
  return {
    sessionId,
    type: "risk",
    status: "active",
    topic: input.topic,
    statement: input.statement,
    confidence: 0.85,
    metadata: input.metadata,
    sourceRefs: [
      {
        eventId: `evt-${input.topic}`,
        eventType: "task_event",
        sessionId,
        timestamp: Date.now(),
      },
    ],
  };
}

describe("memory store", () => {
  test("upsert deduplicates by session + fingerprint", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-dedupe-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const first = store.upsertUnit(
      candidate({
        topic: "verification",
        statement: "verification requires attention",
      }),
    );
    const second = store.upsertUnit(
      candidate({
        topic: "verification",
        statement: "verification requires attention",
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(store.listUnits("memory-store-session")).toHaveLength(1);
  });

  test("resolveUnits supports truth_fact directives", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-resolve-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const verification = store.upsertUnit(
      candidate({
        topic: "verification",
        statement: "verification requires attention",
        metadata: {
          truthFactId: "truth:verification:1",
        },
      }),
    ).unit;

    const resolved = store.resolveUnits({
      sessionId: "memory-store-session",
      sourceType: "truth_fact",
      sourceId: "truth:verification:1",
      resolvedAt: Date.now(),
    });

    expect(resolved).toBe(1);
    expect(
      store.listUnits("memory-store-session").find((unit) => unit.id === verification.id)?.status,
    ).toBe("resolved");
  });

  test("stores and clears working snapshot per session", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-working-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    store.setWorkingSnapshot({
      sessionId: "memory-store-session",
      generatedAt: Date.now(),
      sourceUnitIds: ["u1"],
      sections: [
        {
          title: "Now",
          lines: ["- current state"],
        },
      ],
      content: "[WorkingMemory]\nNow\n- current state",
    });

    expect(store.getWorkingSnapshot("memory-store-session")).toBeDefined();
    store.clearWorkingSnapshot("memory-store-session");
    expect(store.getWorkingSnapshot("memory-store-session")).toBeUndefined();
  });

  test("purges incompatible on-disk units when removed unit types are encountered", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-legacy-"));
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
        confidence: 0.9,
        fingerprint: "fp-legacy-1",
        sourceRefs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
      })}\n`,
      "utf8",
    );

    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });
    expect(store.listUnits("legacy-session")).toHaveLength(0);
    expect(readFileSync(unitsPath, "utf8")).toBe("");
    expect(existsSync(join(rootDir, "state.json"))).toBe(true);
  });
});
