import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInspectCli } from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS4: `brewva inspect --verify-replay` rebuilds the recovery posture from a
// cold second adapter over the same tape and confirms it matches the served
// report. Because the recovery projections are no-cache, a clean session verifies.
describe("inspect --verify-replay (RFC WS4)", () => {
  test("reports equivalence (exit 0) for a session rebuilt from tape", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-verify-replay-"));
    const sessionId = "verify-replay-session";
    const seed = createHostedRuntimeAdapter({ cwd });
    seed.ops.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    seed.ops.session.rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });

    const exitCode = await runInspectCli(["--verify-replay", "--session", sessionId, "--cwd", cwd]);
    expect(exitCode).toBe(0);
  });
});
