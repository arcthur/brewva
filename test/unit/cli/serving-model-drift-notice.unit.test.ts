import { describe, expect, test } from "bun:test";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import { createPromptMessageEndEvent } from "../../helpers/prompt-session-events.js";
import { createShellFixture } from "../../helpers/shell-fixture.js";

// When automatic provider fallback answers a turn with a DIFFERENT model than
// the operator selected, the shell must say so: the status bar keeps showing
// the selected model, so without a notice the downgrade is invisible (e.g. the
// selected gpt-5.5-pro is not entitled on the account and gpt-5.4-mini quietly
// answered — including a degraded "what is 1?" reply).

function assistantMessage(model: string): unknown {
  return {
    role: "assistant",
    model,
    provider: "openai-codex",
    content: [{ type: "text", text: "hello" }],
  };
}

async function startRuntime() {
  const fixture = createShellFixture({
    models: [
      {
        provider: "openai-codex",
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        contextWindow: 400_000,
        maxTokens: 128_000,
        reasoning: true,
      },
    ],
  });
  const runtime = new CliShellRuntime(fixture.bundle, {
    cwd: process.cwd(),
    openSession: async () => fixture.bundle,
    createSession: async () => fixture.bundle,
    operatorPollIntervalMs: 600_000,
  });
  await runtime.start();
  return { fixture, runtime };
}

describe("serving model drift notice", () => {
  test("warns once when a fallback model answered instead of the selected one", async () => {
    const { fixture, runtime } = await startRuntime();
    try {
      fixture.emitSessionEvent(createPromptMessageEndEvent(assistantMessage("gpt-5.4-mini")));
      const notices = runtime
        .getViewState()
        .notifications.filter((notification) => notification.message.includes("gpt-5.4-mini"));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.message).toContain("gpt-5.5-pro");
      expect(notices[0]?.level).toBe("warning");

      // The same drift pair does not spam on every turn.
      fixture.emitSessionEvent(createPromptMessageEndEvent(assistantMessage("gpt-5.4-mini")));
      expect(
        runtime
          .getViewState()
          .notifications.filter((notification) => notification.message.includes("gpt-5.4-mini")),
      ).toHaveLength(1);
    } finally {
      runtime.dispose();
    }
  });

  test("stays silent when the selected model answered", async () => {
    const { fixture, runtime } = await startRuntime();
    try {
      fixture.emitSessionEvent(createPromptMessageEndEvent(assistantMessage("gpt-5.5-pro")));
      expect(
        runtime
          .getViewState()
          .notifications.filter((notification) =>
            notification.message.includes("automatic fallback"),
          ),
      ).toHaveLength(0);
    } finally {
      runtime.dispose();
    }
  });
});
