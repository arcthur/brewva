import { afterEach, describe, expect, test } from "bun:test";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import { startShellRuntimeFixture, type ShellRuntimeFixture } from "../../helpers/shell-fixture.js";
import { streamAssistantText } from "../../helpers/shell-replay.js";

function readTranscriptText(fixture: ShellRuntimeFixture): string {
  return fixture.runtime
    .getViewState()
    .transcript.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.text),
    )
    .join("");
}

let fixture: ShellRuntimeFixture | undefined;

afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

describe("shell streaming invariants", () => {
  test("token deltas accumulate into a single assistant transcript message", async () => {
    fixture = await startShellRuntimeFixture();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    streamAssistantText(fixture, { text, chunkSize: 5, intervalMs: 10 });
    fixture.clock.runAll();

    const assistantMessages = fixture.runtime
      .getViewState()
      .transcript.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(readTranscriptText(fixture)).toContain(text);
  });

  test("change emissions stay bounded by the streaming flush cadence", async () => {
    fixture = await startShellRuntimeFixture();
    const baselineEmits = fixture.emitCount();

    const text = "x".repeat(2_000);
    const { deltaCount, simulatedMs } = streamAssistantText(fixture, {
      text,
      chunkSize: 4,
      intervalMs: 5,
      end: false,
    });
    fixture.clock.runAll();

    const streamingEmits = fixture.emitCount() - baselineEmits;
    const flushBudget = Math.ceil(simulatedMs / CliShellRuntime.STREAMING_RENDER_INTERVAL_MS) + 1;
    expect(deltaCount).toBe(500);
    expect(streamingEmits).toBeGreaterThan(0);
    expect(streamingEmits).toBeLessThanOrEqual(flushBudget);
  });

  test("a delta burst within one flush window coalesces into bounded emits", async () => {
    fixture = await startShellRuntimeFixture();
    const baselineEmits = fixture.emitCount();

    streamAssistantText(fixture, {
      text: "y".repeat(400),
      chunkSize: 4,
      intervalMs: 0,
      end: false,
    });
    fixture.clock.runAll();

    // 100 deltas with no time passing must collapse into at most two
    // flush-driven emits (leading flush + trailing scheduled flush).
    expect(fixture.emitCount() - baselineEmits).toBeLessThanOrEqual(2);
  });
});
