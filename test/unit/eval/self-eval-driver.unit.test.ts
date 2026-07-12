import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOperatorConfigOutsideWorkspace,
  buildOperatorEnvelope,
  collectRunOutcome,
} from "../../eval/self-eval/driver.js";
import type { SelfEvalOracle } from "../../eval/self-eval/types.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

function stageTape(workspace: string, lines: readonly unknown[]): void {
  mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "tape", "session-x.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

// A trivially passing / failing command oracle keeps these tests focused on
// collectRunOutcome's taskOutcome LOGIC (does it run the oracle, and only on a
// completed turn?) rather than on the oracle mechanism, which is unit-tested
// separately over staged workspaces.
const PASS_ORACLE: SelfEvalOracle = { kind: "command", command: ["true"] };
const FAIL_ORACLE: SelfEvalOracle = { kind: "command", command: ["false"] };

function fixtureRef(oracle: SelfEvalOracle) {
  return { id: "fix-arithmetic-bug", kind: "build" as const, oracle, workspaceFiles: {} };
}

describe("self-eval driver run-outcome collection (no live provider)", () => {
  test("reads structural metrics from the durable tape and cost from stdout", async () => {
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

    const result = await collectRunOutcome({
      fixture: fixtureRef(PASS_ORACLE),
      workspace,
      stdout,
      exitCode: 0,
      timedOut: false,
    });

    expect(result.tapePresent).toBe(true);
    expect(result.fixtureId).toBe("fix-arithmetic-bug");
    expect(result.kind).toBe("build");
    expect(result.metrics.distinctTools).toEqual(["edit", "exec", "read"]);
    expect(result.metrics.toolCallCount).toBe(3);
    expect(result.metrics.terminalOutcome).toBe("completed");
    expect(result.metrics.cost).toEqual({ totalTokens: 1234, totalCostUsd: 0.05 });
    // A completed turn runs the oracle: a passing oracle -> task_passed.
    expect(result.taskOutcome).toBe("task_passed");
    expect(result.timedOut).toBe(false);
  });

  test("a completed turn whose oracle fails scores task_failed, not task_passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "edit", timestamp: 2 }),
      { type: "turn.ended", payload: { cause: "terminal_commit" }, timestamp: 3 },
    ]);

    const result = await collectRunOutcome({
      fixture: fixtureRef(FAIL_ORACLE),
      workspace,
      stdout: "",
      exitCode: 0,
      timedOut: false,
    });

    expect(result.metrics.terminalOutcome).toBe("completed");
    // The model stopped cleanly but the task's own test does not pass: the run is
    // NOT scored as success. This is the completed-vs-actually-done distinction.
    expect(result.taskOutcome).toBe("task_failed");
  });

  test("ignores advisory runtime.ops turn.* events so a completed run is not misscored", async () => {
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

    const result = await collectRunOutcome({
      fixture: fixtureRef(PASS_ORACLE),
      workspace,
      stdout: "",
      exitCode: 0,
      timedOut: false,
    });

    expect(result.metrics.terminalOutcome).toBe("completed");
    expect(result.metrics.turnCount).toBe(1);
    expect(result.metrics.toolCallCount).toBe(1);
  });

  test("a failed turn (terminal_commit + status:failed) is terminal_incomplete, oracle not run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      { type: "turn.ended", payload: { cause: "terminal_commit", status: "failed" }, timestamp: 3 },
    ]);

    const result = await collectRunOutcome({
      // A passing oracle would say task_passed IF it ran — it must NOT run on a
      // turn that never completed.
      fixture: {
        id: "implement-missing-functions",
        kind: "build",
        oracle: PASS_ORACLE,
        workspaceFiles: {},
      },
      workspace,
      stdout: "",
      exitCode: 1,
      timedOut: false,
    });

    expect(result.metrics.terminalOutcome).toBe("incomplete");
    expect(result.taskOutcome).toBe("terminal_incomplete");
  });

  test("records a fail-closed suspension outcome from the tape tail", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      { type: "runtime.suspended", payload: { cause: "approval_pending" }, timestamp: 3 },
    ]);

    const result = await collectRunOutcome({
      fixture: { id: "debug-regex", kind: "debug", oracle: PASS_ORACLE, workspaceFiles: {} },
      workspace,
      stdout: "",
      exitCode: 1,
      timedOut: false,
    });

    expect(result.metrics.terminalOutcome).toBe("suspended_for_approval");
    expect(result.taskOutcome).toBe("terminal_incomplete");
    expect(result.metrics).not.toHaveProperty("cost");
  });

  test("a timed-out run is terminal_incomplete even if its tape tail looks completed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));
    stageTape(workspace, [
      { type: "turn.started", payload: { mode: "text" }, timestamp: 1 },
      { type: "turn.ended", payload: { cause: "terminal_commit" }, timestamp: 2 },
    ]);

    const result = await collectRunOutcome({
      fixture: fixtureRef(PASS_ORACLE),
      workspace,
      stdout: "",
      exitCode: null,
      timedOut: true,
    });

    expect(result.timedOut).toBe(true);
    // timedOut takes precedence: the run did not finish under its own power.
    expect(result.taskOutcome).toBe("terminal_incomplete");
  });

  test("records a missing tape honestly instead of scoring an empty run as success", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-collect-"));

    const result = await collectRunOutcome({
      fixture: { id: "no-tape", kind: "comprehension", oracle: PASS_ORACLE, workspaceFiles: {} },
      workspace,
      stdout: "",
      exitCode: null,
      timedOut: false,
    });

    expect(result.tapePresent).toBe(false);
    expect(result.metrics.terminalOutcome).toBe("unknown");
    expect(result.metrics.toolCallCount).toBe(0);
    expect(result.taskOutcome).toBe("terminal_incomplete");
  });
});

describe("operator config outside-workspace guard (fail loud, not silent)", () => {
  test("throws when the operator config resolves inside the workspace repo root", () => {
    // A workspace carrying a .git marker IS its own repo root; a config inside it
    // would be stripped by the operator-source barrier, silently suspending every
    // exec fixture. The guard converts that footgun into an error.
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-guard-"));
    writeFileSync(join(workspace, ".git"), "", "utf8");
    const insideConfig = join(workspace, "operator", "brewva.json");
    expect(() => assertOperatorConfigOutsideWorkspace(insideConfig, workspace)).toThrow(
      /operator-source barrier would strip/,
    );
  });

  test("passes when the operator config is a sibling outside the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "self-eval-guard-parent-"));
    const workspace = mkdtempSync(join(parent, "ws-"));
    const outsideConfig = join(parent, "operator-xyz", "brewva.json");
    let rejected = false;
    try {
      assertOperatorConfigOutsideWorkspace(outsideConfig, workspace);
    } catch {
      rejected = true;
    }
    // A sibling under the same parent (no repo marker) is outside the workspace
    // root, so the guard accepts it.
    expect(rejected).toBe(false);
  });
});

describe("operator envelope assembly (launch-authority config)", () => {
  test("pins security.execution.backend to host so exec fixtures run without boxlite", () => {
    // The default backend is "box", which needs boxlite installed. On a dev host
    // without it, an exec auto-approved by unattendedApproval would still fail to
    // execute and every exec fixture would report terminal_incomplete — an
    // all-broken corpus that looks like a broken harness. Pinning host makes the
    // fixtures hermetic on the execution-backend axis the same way the operator
    // approval policy makes them hermetic on the approval axis.
    const envelope = buildOperatorEnvelope({
      workspace_read: "allow",
      workspace_write: "allow",
      local_exec: "allow",
    });
    expect(envelope.security.execution.backend).toBe("host");
  });

  test("carries the operator approval policy verbatim under security.unattendedApproval", () => {
    const policy = { workspace_read: "allow", local_exec: "allow" } as const;
    const envelope = buildOperatorEnvelope(policy);
    expect(envelope.security.unattendedApproval).toEqual(policy);
  });
});
