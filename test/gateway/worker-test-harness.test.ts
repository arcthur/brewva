import { describe, expect, test } from "bun:test";
import {
  buildWorkerTestHarnessEnv,
  resolveWorkerTestHarness,
} from "../../packages/brewva-gateway/src/session/worker-test-harness.js";

describe("worker test harness", () => {
  test("round-trips watchdog and fake assistant overrides through the shared harness", () => {
    const env = buildWorkerTestHarnessEnv({
      watchdog: {
        taskGoal: "Exercise worker watchdog from tests",
        pollIntervalMs: 1_500,
        investigateMs: 2_000,
        executeMs: 3_000,
      },
      fakeAssistantText: "WORKER_TEST_OK",
    });

    expect(resolveWorkerTestHarness(env)).toEqual({
      enabled: true,
      watchdog: {
        taskGoal: "Exercise worker watchdog from tests",
        pollIntervalMs: 1_500,
        thresholdsMs: {
          investigate: 2_000,
          execute: 3_000,
          verify: undefined,
        },
      },
      fakeAssistantText: "WORKER_TEST_OK",
    });
  });

  test("ignores ambient override values when the harness flag is disabled", () => {
    const env = buildWorkerTestHarnessEnv({
      enabled: false,
      watchdog: {
        taskGoal: "Should be ignored without the opt-in gate",
        pollIntervalMs: 1_000,
        investigateMs: 1_000,
      },
      fakeAssistantText: "IGNORED",
    });

    expect(resolveWorkerTestHarness(env)).toEqual({
      enabled: false,
      watchdog: {},
    });
  });

  test("drops empty strings and invalid durations during env construction", () => {
    const env = buildWorkerTestHarnessEnv({
      watchdog: {
        taskGoal: "   ",
        pollIntervalMs: 0,
        investigateMs: Number.NaN,
        executeMs: -5,
        verifyMs: 1_999.9,
      },
      fakeAssistantText: "   trimmed response   ",
    });

    expect(env).toMatchObject({
      BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES: "1",
      BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL: undefined,
      BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS: undefined,
      BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS: undefined,
      BREWVA_INTERNAL_GATEWAY_WATCHDOG_EXECUTE_MS: undefined,
      BREWVA_INTERNAL_GATEWAY_WATCHDOG_VERIFY_MS: "1999",
      BREWVA_INTERNAL_GATEWAY_FAKE_ASSISTANT_TEXT: "trimmed response",
    });
  });
});
