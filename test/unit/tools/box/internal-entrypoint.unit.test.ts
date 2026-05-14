import { describe, expect, test } from "bun:test";
import type {
  BoxInventoryEntry,
  BoxMetrics,
  BoxNativeState,
} from "../../../../packages/brewva-tools/src/internal/box/index.js";

describe("tools internal box entrypoint", () => {
  test("exports inventory inspection types from the internal surface", async () => {
    const surface = await import("../../../../packages/brewva-tools/src/internal/box/index.js");
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
