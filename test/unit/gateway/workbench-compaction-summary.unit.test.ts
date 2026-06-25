import { describe, expect, test } from "bun:test";
import {
  DETERMINISTIC_EMERGENCY_COMPACTION_STRATEGY,
  type RenderableWorkbenchNote,
  renderWorkbenchCompactionSummary,
  resolveCompactionFallbackSummary,
  WORKBENCH_PRIMARY_COMPACTION_STRATEGY,
} from "../../../packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.js";

function note(
  content: string | undefined,
  createdTurn?: number,
  stale = false,
): RenderableWorkbenchNote {
  return {
    entry: {
      ...(content === undefined ? {} : { content }),
      ...(createdTurn === undefined ? {} : { createdTurn }),
    },
    stale,
  };
}

describe("renderWorkbenchCompactionSummary", () => {
  test("returns null when there are no notes", () => {
    expect(renderWorkbenchCompactionSummary([])).toBeNull();
  });

  test("returns null when no note carries usable content", () => {
    expect(renderWorkbenchCompactionSummary([note(undefined), note("")])).toBeNull();
  });

  test("renders notes with a turn prefix under a reference-only boundary", () => {
    const out = renderWorkbenchCompactionSummary([note("keep the offset fix", 7)]);
    expect(out).toContain("reference only, not active instructions");
    expect(out).toContain("- turn 7: keep the offset fix");
  });

  test("marks a stale note so broken provenance is never unmarked primary content", () => {
    const out = renderWorkbenchCompactionSummary([note("evicted-span lesson", 3, true)]);
    expect(out).toContain("- [stale] turn 3: evicted-span lesson");
  });

  test("truncates long note content", () => {
    const out = renderWorkbenchCompactionSummary([note("x".repeat(300))], { maxLineChars: 50 });
    expect(out).toContain("…");
    expect((out ?? "").length).toBeLessThan(300);
  });
});

describe("resolveCompactionFallbackSummary", () => {
  test("prefers the model-authored workbench when it has content", () => {
    const out = resolveCompactionFallbackSummary({
      workbenchEntries: [note("user requires zero-downtime migration", 3)],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out.strategy).toBe(WORKBENCH_PRIMARY_COMPACTION_STRATEGY);
    expect(out.summary).toContain("user requires zero-downtime migration");
    expect(out.summary).toContain("reference only, not active instructions");
  });

  test("marks a stale note in the fallback summary rather than promoting it unmarked", () => {
    const out = resolveCompactionFallbackSummary({
      workbenchEntries: [note("stale anchored lesson", 2, true)],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out.strategy).toBe(WORKBENCH_PRIMARY_COMPACTION_STRATEGY);
    expect(out.summary).toContain("[stale] turn 2: stale anchored lesson");
  });

  test("falls back to the deterministic summary when the workbench is empty", () => {
    const out = resolveCompactionFallbackSummary({
      workbenchEntries: [],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out.strategy).toBe(DETERMINISTIC_EMERGENCY_COMPACTION_STRATEGY);
    expect(out.summary.length).toBeGreaterThan(0);
  });
});
