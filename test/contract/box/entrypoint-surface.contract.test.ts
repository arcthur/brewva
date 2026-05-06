import { describe, expect, test } from "bun:test";
import type { BoxInventoryEntry, BoxMetrics, BoxNativeState } from "@brewva/brewva-box";

describe("box package entrypoint", () => {
  test("exports inventory inspection types from the public surface", async () => {
    const surface = await import("@brewva/brewva-box");
    const metrics: BoxMetrics = {
      commandsExecutedTotal: 1,
      execErrorsTotal: 0,
      bytesSentTotal: 16,
      bytesReceivedTotal: 32,
    };
    const nativeState: BoxNativeState = { status: "running", running: true };
    const entry: Pick<BoxInventoryEntry, "nativeState" | "metrics"> = {
      nativeState,
      metrics,
    };

    expect(surface.createBoxPlane).toBeFunction();
    expect(entry.metrics?.commandsExecutedTotal).toBe(1);
    expect(entry.nativeState?.running).toBe(true);
  });
});
