import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

const toolExecutor: RuntimeToolExecutorPort = {
  async execute(commitment) {
    return {
      outcome: { kind: "ok", value: {} },
      content: `executed:${commitment.call.toolCallId}`,
    };
  },
};

describe("runtime turn provider error retry classification", () => {
  test("does not retry a provider error flagged non-retryable", async () => {
    let providerCalls = 0;
    const provider: RuntimeProviderPort = {
      // eslint-disable-next-line require-yield
      async *stream() {
        providerCalls += 1;
        const error = new Error(
          "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
        ) as Error & { retryable?: boolean };
        error.retryable = false;
        throw error;
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-nonretryable-")),
      physics: { mode: "real", provider, toolExecutor },
    });

    let thrown: unknown;
    try {
      await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "design a chess game" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/not supported when using Codex/);

    // Permanent errors must fail fast: exactly one provider attempt, no retry.
    expect(providerCalls).toBe(1);
    expect(runtime.tape.list("s1", { type: "runtime.suspended" })).toHaveLength(0);
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toMatchObject({
      cause: "terminal_commit",
      status: "failed",
    });
  });

  test("still retries an unflagged provider stream error once", async () => {
    let providerCalls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new Error("transient stream blip");
        }
        yield { type: "text", delta: "recovered" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-retryable-")),
      physics: { mode: "real", provider, toolExecutor },
    });

    const frames = await Array.fromAsync(
      runtime.turn({ sessionId: "s1", prompt: "design a chess game" }),
    );

    // Unflagged errors preserve the existing retry-once behavior.
    expect(providerCalls).toBe(2);
    expect(frames).toContainEqual({ type: "text", delta: "recovered" });
  });
});
