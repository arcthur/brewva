import { describe, expect, test } from "bun:test";
import { createSessionWireRelayGate } from "../../../packages/brewva-gateway/src/hosted/edge/worker/relay-gate.js";

describe("session wire relay gate", () => {
  test("uses explicit pause depth instead of turn busy state for relay suppression", () => {
    const gate = createSessionWireRelayGate();

    expect(gate.isPaused()).toBe(false);

    const releaseOuter = gate.pause();
    const releaseInner = gate.pause();

    expect(gate.isPaused()).toBe(true);

    releaseOuter();
    expect(gate.isPaused()).toBe(true);

    releaseOuter();
    expect(gate.isPaused()).toBe(true);

    releaseInner();
    expect(gate.isPaused()).toBe(false);
  });
});
