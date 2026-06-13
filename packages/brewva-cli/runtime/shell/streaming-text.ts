import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { ShellClock, ShellScheduledTimeout } from "../../src/shell/domain/clock.js";

/**
 * Throttle the text fed to a streaming markdown renderable so the
 * accumulated content is re-parsed and re-laid-out at most once per
 * `intervalMs` while tokens are still arriving. The runtime already
 * coalesces deltas to the 16ms flush cadence, but markdown work on every
 * flush still grows O(content) per frame over a long response; ~10Hz is
 * indistinguishable for prose while cutting that work by ~6x. Leading edge
 * emits immediately so the first token is never delayed; within the window
 * a single trailing flush carries the latest text. When `streaming` flips
 * false the latest text passes through immediately so the finalized block
 * always renders complete.
 *
 * Scheduling goes through the shell clock so replay tests drive the
 * throttle deterministically together with the runtime's own timers.
 */
export const STREAMING_TEXT_THROTTLE_MS = 100;

export function createStreamingText(
  text: Accessor<string>,
  streaming: Accessor<boolean>,
  options: { clock: ShellClock; intervalMs?: number },
): Accessor<string> {
  const intervalMs = options.intervalMs ?? STREAMING_TEXT_THROTTLE_MS;
  const clock = options.clock;
  const [shown, setShown] = createSignal(text());
  let lastEmitAt: number | undefined;
  let trailing: ShellScheduledTimeout | undefined;

  const cancelTrailing = (): void => {
    trailing?.cancel();
    trailing = undefined;
  };

  createEffect(() => {
    const value = text();
    if (!streaming()) {
      cancelTrailing();
      lastEmitAt = undefined;
      setShown(() => value);
      return;
    }
    // An unchanged value (e.g. the initial mount run) must not consume the
    // leading edge, or the first real token would wait a full window.
    if (value === untrack(shown)) {
      return;
    }
    const elapsed = lastEmitAt === undefined ? undefined : clock.now() - lastEmitAt;
    if (elapsed === undefined || elapsed >= intervalMs) {
      cancelTrailing();
      lastEmitAt = clock.now();
      setShown(() => value);
      return;
    }
    if (trailing) {
      return;
    }
    trailing = clock.schedule(() => {
      trailing = undefined;
      lastEmitAt = clock.now();
      setShown(() => text());
    }, intervalMs - elapsed);
  });

  onCleanup(cancelTrailing);
  return shown;
}
