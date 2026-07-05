import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  backgroundFollowUpLine,
  resolveExecForegroundYieldMs,
} from "../../../packages/brewva-tools/src/families/execution/exec/shared.js";

// P3 — exec adaptive pacing. The verification-class foreground wait
// (`verificationForegroundWaitMs`, default 120s) must OWN the wait for a
// build/test/lint/typecheck command: an explicit low `yieldMs` may raise it but
// must never silently truncate the build below it. The observed regression on a
// real hosted tape was `yieldMs: 1000` on `make build`, which backgrounded the
// build in 1s and collapsed pacing into a `process poll until="activity"` churn
// loop. General commands keep verbatim yieldMs honoring (no floor).
const autoBackground = DEFAULT_BREWVA_CONFIG.security.execution.autoBackground; // {foreground:10_000, verification:120_000}

describe("resolveExecForegroundYieldMs — verification foreground wait is a FLOOR", () => {
  test("background:true always yields immediately (0), even for a verification command", () => {
    expect(
      resolveExecForegroundYieldMs({
        command: "make build",
        background: true,
        params: { yieldMs: 500 },
        autoBackground,
      }),
    ).toBe(0);
  });

  test("a verification command with no explicit yieldMs uses the verification wait (120s)", () => {
    expect(
      resolveExecForegroundYieldMs({
        command: "swift build",
        background: false,
        params: {},
        autoBackground,
      }),
    ).toBe(120_000);
  });

  test("a low explicit yieldMs CANNOT truncate a verification command below the floor (the regression)", () => {
    expect(
      resolveExecForegroundYieldMs({
        command: "make build",
        background: false,
        params: { yieldMs: 1000 },
        autoBackground,
      }),
    ).toBe(120_000);
  });

  test("an explicit yieldMs may still RAISE the wait above a lower configured verification floor", () => {
    const lowFloor = { ...autoBackground, verificationForegroundWaitMs: 5_000 };
    // Above the floor → honored (raise allowed).
    expect(
      resolveExecForegroundYieldMs({
        command: "npm test",
        background: false,
        params: { yieldMs: 30_000 },
        autoBackground: lowFloor,
      }),
    ).toBe(30_000);
    // Below the floor → raised back to the floor (no truncation).
    expect(
      resolveExecForegroundYieldMs({
        command: "npm test",
        background: false,
        params: { yieldMs: 1_000 },
        autoBackground: lowFloor,
      }),
    ).toBe(5_000);
  });

  test("a general (non-verification) command honors an explicit low yieldMs verbatim — no floor", () => {
    expect(
      resolveExecForegroundYieldMs({
        command: "printf hello",
        background: false,
        params: { yieldMs: 1_000 },
        autoBackground,
      }),
    ).toBe(1_000);
  });

  test("a general command with no explicit yieldMs uses the general foreground wait (10s), not the verification 120s", () => {
    expect(
      resolveExecForegroundYieldMs({
        command: "ls -la",
        background: false,
        params: {},
        autoBackground,
      }),
    ).toBe(10_000);
  });
});

describe("backgroundFollowUpLine — a backgrounded verification command is steered to until=exit", () => {
  const generic = "Use process (list/poll/log/kill/clear/remove) for follow-up.";

  test("a verification command that still backgrounded is told to poll with `until=exit`", () => {
    const line = backgroundFollowUpLine("make build", generic);
    expect(line).toContain("until=exit");
    expect(line).not.toBe(generic);
  });

  test("a general command keeps the generic process follow-up surface", () => {
    expect(backgroundFollowUpLine("printf hello", generic)).toBe(generic);
  });
});
