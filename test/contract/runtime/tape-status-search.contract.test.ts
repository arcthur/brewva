import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { requireNonEmptyString } from "../../helpers/assertions.js";

describe("tape status and search", () => {
  test("recordTapeHandoff writes anchor and resets entriesSinceAnchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-status-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-status-1";

    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "status baseline",
    });
    runtime.authority.task.items.add(sessionId, { text: "before anchor" });

    const before = runtime.inspect.tape.status.get(sessionId);
    expect(before.totalEntries).toBeGreaterThan(0);
    expect(before.entriesSinceAnchor).toBe(before.totalEntries);

    const handoff = runtime.authority.tape.handoff.record(sessionId, {
      name: "investigation-done",
      summary: "captured findings",
      nextSteps: "implement changes",
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) {
      throw new Error(handoff.reason);
    }
    requireNonEmptyString(handoff.eventId, "missing tape handoff event id");

    const after = runtime.inspect.tape.status.get(sessionId);
    expect(after.lastAnchor?.name).toBe("investigation-done");
    expect(after.entriesSinceAnchor).toBe(0);

    runtime.authority.task.items.add(sessionId, { text: "after anchor" });
    const afterMore = runtime.inspect.tape.status.get(sessionId);
    expect(afterMore.entriesSinceAnchor).toBeGreaterThan(0);
  });

  test("searchTape scopes current phase by latest anchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-search-1";

    runtime.authority.tape.handoff.record(sessionId, {
      name: "phase-a",
      summary: "alpha baseline",
      nextSteps: "continue",
    });
    runtime.authority.task.items.add(sessionId, { text: "alpha task" });

    runtime.authority.tape.handoff.record(sessionId, {
      name: "phase-b",
      summary: "beta baseline",
      nextSteps: "continue",
    });
    runtime.authority.task.items.add(sessionId, { text: "beta task" });

    const allPhases = runtime.inspect.tape.search.search(sessionId, {
      query: "alpha",
      scope: "all_phases",
    });
    expect(allPhases.matches.length).toBeGreaterThan(0);

    const currentPhase = runtime.inspect.tape.search.search(sessionId, {
      query: "alpha",
      scope: "current_phase",
    });
    expect(currentPhase.matches).toHaveLength(0);

    const anchorOnly = runtime.inspect.tape.search.search(sessionId, {
      query: "phase-b",
      scope: "anchors_only",
    });
    expect(anchorOnly.matches.length).toBe(1);
    expect(anchorOnly.matches[0]?.type).toBe("anchor");
  });

  test("searchTape uses token overlap for Chinese event text", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-search-cjk-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-search-cjk";

    runtime.authority.tape.handoff.record(sessionId, {
      name: "phase-a",
      summary: "数据库连接失败调查",
      nextSteps: "继续定位启动路径",
    });
    runtime.authority.task.items.add(sessionId, { text: "修复数据库连接被拒绝导致启动失败" });

    runtime.authority.tape.handoff.record(sessionId, {
      name: "phase-b",
      summary: "缓存刷新完成",
      nextSteps: "继续验证",
    });
    runtime.authority.task.items.add(sessionId, { text: "缓存刷新成功" });

    const allPhases = runtime.inspect.tape.search.search(sessionId, {
      query: "数据库启动失败",
      scope: "all_phases",
    });
    expect(allPhases.matches.length).toBeGreaterThan(0);
    expect(allPhases.matches[0]?.excerpt).toContain("数据库");

    const currentPhase = runtime.inspect.tape.search.search(sessionId, {
      query: "数据库启动失败",
      scope: "current_phase",
    });
    expect(currentPhase.matches).toHaveLength(0);
  });
});
