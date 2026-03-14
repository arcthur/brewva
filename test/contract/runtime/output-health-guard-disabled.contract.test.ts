import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Output health guard disabled by default", () => {
  test("does not inject an output guard when low-quality output is observed", async () => {
    const workspace = createTestWorkspace("output-health-guard");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "output-health-guard-1";

    runtime.events.record({
      sessionId,
      type: "message_update",
      payload: {
        deltaType: "text_delta",
        deltaChars: 10,
        health: {
          score: 0.2,
          drunk: true,
          flags: ["repetition_high"],
          windowChars: 1000,
        },
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "next");
    expect(injection.text).not.toContain("[OutputHealthGuard]");
  });

  test("does not inject an output guard for healthy output either", async () => {
    const workspace = createTestWorkspace("output-health-ok");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "output-health-guard-ok-1";

    runtime.events.record({
      sessionId,
      type: "message_update",
      payload: {
        deltaType: "text_delta",
        deltaChars: 10,
        health: {
          score: 0.95,
          drunk: false,
          flags: [],
          windowChars: 1000,
        },
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "next");
    expect(injection.text).not.toContain("[OutputHealthGuard]");
  });
});
