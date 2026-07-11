import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunOutcome } from "../../eval/self-eval/driver.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

function stageTape(workspace: string, lines: readonly unknown[]): void {
  mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "tape", "session-x.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

describe("self-eval driver run-outcome collection (no live provider)", () => {
  test("reads structural metrics from the durable tape and cost from stdout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      committedToolEvent({ toolName: "edit", timestamp: 3 }),
      committedToolEvent({ toolName: "exec", timestamp: 4 }),
      { type: "turn.ended", payload: { cause: "terminal_commit" }, timestamp: 5 },
    ]);
    const stdout = JSON.stringify({
      schema: "brewva.stream.v1",
      type: "brewva_event_bundle",
      sessionId: "session-x",
      events: [],
      costSummary: { totalTokens: 1234, totalCostUsd: 0.05 },
    });

    const result = collectRunOutcome({
      fixture: { id: "fix-arithmetic-bug", kind: "build" },
      workspace,
      stdout,
      exitCode: 0,
    });

    expect(result.tapePresent).toBe(true);
    expect(result.fixtureId).toBe("fix-arithmetic-bug");
    expect(result.kind).toBe("build");
    expect(result.metrics.distinctTools).toEqual(["edit", "exec", "read"]);
    expect(result.metrics.toolCallCount).toBe(3);
    expect(result.metrics.terminalOutcome).toBe("completed");
    expect(result.metrics.cost).toEqual({ totalTokens: 1234, totalCostUsd: 0.05 });
  });

  test("ignores advisory runtime.ops turn.* events so a completed run is not misscored", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    // The real embedded --print tape commits BOTH canonical turn.* events AND
    // advisory runtime.ops (custom-wrapped) copies; the advisory turn.ended lands
    // AFTER the canonical one with an empty payload. A runtime.ops-remapping read
    // would take that empty tail and score the completed run as incomplete; raw
    // parse keeps the advisory events as type:"custom" so only the canonical
    // turn.* are read.
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "exec", timestamp: 2 }),
      { type: "turn.ended", payload: { cause: "terminal_commit" }, timestamp: 3 },
      {
        type: "custom",
        payload: { namespace: "runtime.ops", kind: "turn.started", version: 1, payload: {} },
        timestamp: 4,
      },
      {
        type: "custom",
        payload: { namespace: "runtime.ops", kind: "turn.ended", version: 1, payload: {} },
        timestamp: 5,
      },
    ]);

    const result = collectRunOutcome({
      fixture: { id: "fix-arithmetic-bug", kind: "build" },
      workspace,
      stdout: "",
      exitCode: 0,
    });

    expect(result.metrics.terminalOutcome).toBe("completed");
    expect(result.metrics.turnCount).toBe(1);
    expect(result.metrics.toolCallCount).toBe(1);
  });

  test("a failed turn (terminal_commit + status:failed) scores incomplete, not completed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      { type: "turn.ended", payload: { cause: "terminal_commit", status: "failed" }, timestamp: 3 },
    ]);

    const result = collectRunOutcome({
      fixture: { id: "implement-missing-functions", kind: "build" },
      workspace,
      stdout: "",
      exitCode: 1,
    });

    expect(result.metrics.terminalOutcome).toBe("incomplete");
  });

  test("records a fail-closed suspension outcome from the tape tail", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      { type: "runtime.suspended", payload: { cause: "approval_pending" }, timestamp: 3 },
    ]);

    const result = collectRunOutcome({
      fixture: { id: "debug-regex", kind: "debug" },
      workspace,
      stdout: "",
      exitCode: 1,
    });

    expect(result.metrics.terminalOutcome).toBe("suspended_for_approval");
    expect(result.metrics).not.toHaveProperty("cost");
  });

  test("records a missing tape honestly instead of scoring an empty run as success", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));

    const result = collectRunOutcome({
      fixture: { id: "no-tape", kind: "comprehension" },
      workspace,
      stdout: "",
      exitCode: null,
    });

    expect(result.tapePresent).toBe(false);
    expect(result.metrics.terminalOutcome).toBe("unknown");
    expect(result.metrics.toolCallCount).toBe(0);
  });
});
