import { describe, expect, test } from "bun:test";
import { createRuntimeTurnClockStore } from "../../../packages/brewva-gateway/src/runtime-plugins/runtime-turn-clock.js";

describe("runtime turn clock", () => {
  test("isolates turn state per store instance", () => {
    const left = createRuntimeTurnClockStore();
    const right = createRuntimeTurnClockStore();

    expect(left.observeTurnStart("session-a", 0, 100)).toBe(0);
    expect(left.observeTurnStart("session-a", 1, 200)).toBe(1);

    expect(right.getCurrentTurn("session-a")).toBe(0);
    expect(right.observeTurnStart("session-a", 0, 100)).toBe(0);
    expect(right.getCurrentTurn("session-a")).toBe(0);

    left.clearSession("session-a");
    expect(left.getCurrentTurn("session-a")).toBe(0);
    expect(right.getCurrentTurn("session-a")).toBe(0);
  });
});
