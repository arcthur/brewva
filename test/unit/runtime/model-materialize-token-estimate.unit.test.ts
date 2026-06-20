import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

const toolExecutor: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "" };
  },
};

function answerProvider(text: string): RuntimeProviderPort {
  return {
    async *stream() {
      yield { type: "text", delta: text };
    },
  };
}

describe("runtime model materialize token estimate", () => {
  test("estimates prompt size in BPE tokens, not raw characters", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-materialize-token-")),
      physics: { mode: "real", provider: answerProvider("ok"), toolExecutor },
    });

    // ~2000 characters of natural-language text encode to ~400 BPE tokens.
    const prompt = "word ".repeat(400);
    await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt }));

    // The budget sits between the true token count (~400) and the raw
    // character count (>2000). A character-based estimate over-reports and
    // wrongly flags over_window; a BPE estimate stays ready.
    const plan = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 1000 },
    });

    expect(plan.tokenEstimate).toBeLessThan(1000);
    expect(plan.status).toBe("ready");
  });
});
