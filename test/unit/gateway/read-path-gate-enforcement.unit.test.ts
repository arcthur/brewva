import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeReadPathRecoveryState,
  buildReadPathRecoveryBlocks,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.js";
import { createCompactReadTool } from "../../../packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

// Read-path recovery is EVIDENCE, not a gate (RFC: harness candidate
// integrity and descriptive-authority subtraction, P2). Repeated missing-path
// failures arm a recovery-evidence state that renders an evidential context
// block and tape events; the read tool itself is never deflected — the model
// decides how to recover. This file replaced the former gate-enforcement
// contract when the tool-layer interception was deleted.

function readCtx(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function executeRead(
  tool: ReturnType<typeof createCompactReadTool>,
  sessionId: string,
  path: string,
): Promise<{ text: string; outcomeKind: string | undefined }> {
  const result = (await tool.execute(
    "tc-read",
    { path },
    undefined as never,
    undefined as never,
    readCtx(sessionId) as never,
  )) as {
    content?: Array<{ type?: string; text?: string }>;
    outcome?: { kind?: string };
  };
  return {
    text: (result.content ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n"),
    outcomeKind: result.outcome?.kind,
  };
}

describe("read-path recovery evidence", () => {
  test("an armed recovery state never blocks reads and renders evidence instead", async () => {
    const workspace = createTestWorkspace("read-path-recovery");
    const sessionId = "read-recovery-session";
    try {
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(join(workspace, "docs/notes.md"), "release notes\n", "utf8");

      const runtime = createRuntimeFixture();
      const tool = createCompactReadTool({ cwd: workspace, runtime });

      runtime.ops.tools.readPath.gateArmed({
        sessionId,
        payload: {
          consecutiveMissingPathFailures: 2,
          failedPaths: ["missing-a.ts", "missing-b.ts"],
        },
      });

      // The armed state renders as an evidential context block naming the
      // failure run and the failed paths — before any evidence exists.
      const armedBlocks = buildReadPathRecoveryBlocks(runtime, sessionId);
      expect(armedBlocks.map((block) => block.id)).toEqual(["read-path-recovery"]);
      const armedContent = armedBlocks[0]?.content ?? "";
      expect(armedContent).toContain("2 consecutive path-not-found failures");
      expect(armedContent).toContain("missing-a.ts, missing-b.ts");
      expect(armedContent).toContain("No discovery evidence has been observed since");

      // Armed with zero discovery evidence: the read still executes — no
      // deflection, no guard receipt.
      const read = await executeRead(tool, sessionId, "docs/notes.md");
      expect(read.outcomeKind).not.toBe("err");
      expect(read.text).toContain("release notes");
      expect(read.text).not.toContain("[ReadPathGuard]");

      // The successful read itself records discovery evidence for its
      // directory, flipping the block to its satisfied shape.
      const satisfiedBlocks = buildReadPathRecoveryBlocks(runtime, sessionId);
      expect(satisfiedBlocks[0]?.content ?? "").toContain("observed_directories: docs");
      expect(analyzeReadPathRecoveryState(runtime, sessionId).phase).toBe("satisfied");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
