import { describe, expect, test } from "bun:test";
import { deriveTerminalOutcome, extractSelfEvalRunMetrics } from "../../eval/self-eval/metrics.js";
import type { SelfEvalTapeEvent } from "../../eval/self-eval/types.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

const turnStarted = (): SelfEvalTapeEvent => ({ type: "turn.started", payload: { mode: "text" } });
// Canonical success turn.ended OMITS status (turn/impl commitTurnEnded); a
// failed/cancelled turn carries status. cause is always "terminal_commit".
const turnEnded = (status?: "failed" | "cancelled"): SelfEvalTapeEvent => ({
  type: "turn.ended",
  payload: { cause: "terminal_commit", ...(status ? { status } : {}) },
});
const suspended = (cause = "approval_pending"): SelfEvalTapeEvent => ({
  type: "runtime.suspended",
  payload: { cause },
});

describe("self-eval run metric extraction (frozen evaluator, deterministic gate)", () => {
  test("is deterministic and structural over a completed exec-using run", () => {
    const events: SelfEvalTapeEvent[] = [
      turnStarted(),
      committedToolEvent({ toolName: "read", timestamp: 1 }),
      committedToolEvent({ toolName: "read", timestamp: 2 }),
      committedToolEvent({ toolName: "glob", timestamp: 3 }),
      committedToolEvent({ toolName: "edit", timestamp: 4 }),
      committedToolEvent({ toolName: "exec", timestamp: 5 }),
      // mid-run approval pause auto-approved under a Phase-1 policy
      suspended(),
      committedToolEvent({ toolName: "exec", timestamp: 6 }),
      turnEnded(),
    ];

    const first = extractSelfEvalRunMetrics(events);
    const second = extractSelfEvalRunMetrics(events);
    // Determinism over identical events IS the repeatability gate.
    expect(first).toEqual(second);

    expect(first.distinctTools).toEqual(["edit", "exec", "glob", "read"]);
    expect(first.distinctToolCount).toBe(4);
    expect(first.toolCallCount).toBe(6);
    expect(first.perFamilyCounts).toEqual({ edit: 1, exec: 2, glob: 1, read: 2 });
    expect(first.turnCount).toBe(1);
    expect(first.terminalOutcome).toBe("completed");
    expect(first).not.toHaveProperty("cost");
  });

  test("groups specialized tool names into the RFC family taxonomy", () => {
    const metrics = extractSelfEvalRunMetrics([
      committedToolEvent({ toolName: "source_patch_apply", timestamp: 1 }),
      committedToolEvent({ toolName: "code_digest", timestamp: 2 }),
      committedToolEvent({ toolName: "attention_pin", timestamp: 3 }),
      committedToolEvent({ toolName: "read", timestamp: 4 }),
    ]);
    expect(metrics.perFamilyCounts).toEqual({
      attention: 1,
      code: 1,
      read: 1,
      source_patch: 1,
    });
  });

  test("terminalOutcome reads the canonical turn.ended status, not its constant cause", () => {
    // Uncovered effect class: the run ends still suspended (never resolved).
    expect(
      deriveTerminalOutcome([
        turnStarted(),
        committedToolEvent({ toolName: "read", timestamp: 1 }),
        suspended(),
      ]),
    ).toBe("suspended_for_approval");

    // Clean completion: canonical turn.ended OMITS status on success.
    expect(deriveTerminalOutcome([turnStarted(), turnEnded()])).toBe("completed");

    // Mid-run suspensions that DO resolve into a terminal turn.ended count as
    // completed, not suspended — the tail is the signal, not "any suspension".
    expect(deriveTerminalOutcome([turnStarted(), suspended(), suspended(), turnEnded()])).toBe(
      "completed",
    );

    // A failed/cancelled turn end carries the SAME cause (terminal_commit) but a
    // status field — the status, not the cause, is the completion signal.
    expect(deriveTerminalOutcome([turnStarted(), turnEnded("failed")])).toBe("incomplete");
    expect(deriveTerminalOutcome([turnStarted(), turnEnded("cancelled")])).toBe("incomplete");

    // A suspend left unresolved for a NON-approval cause is not the fail-closed
    // approval signal — it is honestly incomplete, not guessed.
    expect(deriveTerminalOutcome([turnStarted(), suspended("shutdown")])).toBe("incomplete");

    // No lifecycle tail at all.
    expect(deriveTerminalOutcome([committedToolEvent({ toolName: "read", timestamp: 1 })])).toBe(
      "unknown",
    );
  });

  test("counts only committed tools — proposed/started are intent, not exercise", () => {
    const metrics = extractSelfEvalRunMetrics([
      { type: "tool.proposed", payload: { call: { toolName: "exec" } } },
      { type: "tool.started", payload: { call: { toolName: "exec" } } },
      committedToolEvent({ toolName: "exec", timestamp: 1 }),
    ]);
    expect(metrics.toolCallCount).toBe(1);
    expect(metrics.distinctTools).toEqual(["exec"]);
  });
});
