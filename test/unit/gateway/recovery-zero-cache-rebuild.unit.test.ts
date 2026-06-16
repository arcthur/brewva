import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeSessionHydration,
  RuntimeSessionIntegrity,
} from "@brewva/brewva-tools/contracts";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS4 validation signal: a fresh zero-cache projection rebuilt from canonical
// tape equals the normalized served projection. The hosted recovery projections
// are no-cache (every read replays the tape), so a second adapter started cold
// over the same tape must derive the same hydration and integrity posture, with
// no process-local state leaking in. Display clocks are excluded from the compare.
describe("recovery projection zero-cache rebuild equivalence (RFC WS4)", () => {
  const sessionId = "zero-cache-session";

  function normalizeHydration(hydration: RuntimeSessionHydration) {
    // hydratedAt is a display clock (read time); exclude it from the comparison.
    const { hydratedAt: _hydratedAt, ...rest } = hydration;
    return rest;
  }

  function normalizeIntegrity(integrity: RuntimeSessionIntegrity) {
    return integrity;
  }

  test("a cold second adapter rebuilds identical hydration and integrity from tape", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-zero-cache-"));

    // First adapter commits events (writing the durable tape).
    const writer = createHostedRuntimeAdapter({ cwd });
    writer.ops.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    const served = {
      hydration: writer.ops.session.lifecycle.getHydration(sessionId),
      integrity: writer.ops.session.lifecycle.getIntegrity(sessionId),
    };

    // A fresh adapter over the same workspace has no in-process state; it must
    // rebuild the same posture purely by replaying the tape.
    const rebuilt = createHostedRuntimeAdapter({ cwd });
    const fromTape = {
      hydration: rebuilt.ops.session.lifecycle.getHydration(sessionId),
      integrity: rebuilt.ops.session.lifecycle.getIntegrity(sessionId),
    };

    expect(served.hydration.status).toBe("ready");
    expect(normalizeHydration(fromTape.hydration)).toEqual(normalizeHydration(served.hydration));
    expect(normalizeIntegrity(fromTape.integrity)).toEqual(normalizeIntegrity(served.integrity));
    expect(fromTape.hydration.cursor).toEqual(served.hydration.cursor);
  });
});
