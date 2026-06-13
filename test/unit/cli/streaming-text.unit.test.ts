import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, type Accessor, type Setter } from "solid-js";
import { createStreamingText } from "../../../packages/brewva-cli/runtime/shell/streaming-text.js";
import { createManualShellClock, type ManualShellClock } from "../../helpers/manual-shell-clock.js";

interface ThrottleHarness {
  readonly clock: ManualShellClock;
  readonly shown: Accessor<string>;
  readonly setText: Setter<string>;
  readonly setStreaming: Setter<boolean>;
  dispose(): void;
}

/**
 * Effects first run when the root finishes setting up, so the harness
 * builds everything inside `createRoot` and tests drive signals from the
 * outside, where each write re-runs the effect synchronously.
 */
function createThrottleHarness(intervalMs = 100): ThrottleHarness {
  const clock = createManualShellClock();
  const [text, setText] = createSignal("");
  const [streaming, setStreaming] = createSignal(true);
  let shown!: Accessor<string>;
  const dispose = createRoot((disposeRoot) => {
    shown = createStreamingText(text, streaming, { clock, intervalMs });
    return disposeRoot;
  });
  return { clock, shown, setText, setStreaming, dispose };
}

describe("createStreamingText", () => {
  test("emits the first streaming value immediately", () => {
    const harness = createThrottleHarness();
    harness.setText("hello");
    expect(harness.shown()).toBe("hello");
    harness.dispose();
  });

  test("coalesces updates within the throttle window to one trailing flush", () => {
    const harness = createThrottleHarness();
    harness.setText("a");
    expect(harness.shown()).toBe("a");

    harness.clock.advance(10);
    harness.setText("ab");
    harness.clock.advance(10);
    harness.setText("abc");
    expect(harness.shown()).toBe("a");
    expect(harness.clock.pendingCount()).toBe(1);

    harness.clock.advance(100);
    expect(harness.shown()).toBe("abc");
    harness.dispose();
  });

  test("emits on the leading edge once the window has elapsed", () => {
    const harness = createThrottleHarness();
    harness.setText("first");
    harness.clock.advance(150);
    harness.setText("second");
    expect(harness.shown()).toBe("second");
    harness.dispose();
  });

  test("passes the latest value through immediately when streaming ends", () => {
    const harness = createThrottleHarness();
    harness.setText("partial");
    harness.clock.advance(10);
    harness.setText("partial complete");
    expect(harness.shown()).toBe("partial");

    harness.setStreaming(false);
    expect(harness.shown()).toBe("partial complete");
    expect(harness.clock.pendingCount()).toBe(0);
    harness.dispose();
  });

  test("disposal cancels the pending trailing flush", () => {
    const harness = createThrottleHarness();
    harness.setText("a");
    harness.clock.advance(10);
    harness.setText("ab");
    expect(harness.clock.pendingCount()).toBe(1);
    harness.dispose();
    expect(harness.clock.pendingCount()).toBe(0);
  });
});
