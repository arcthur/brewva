import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCompactReadTool } from "../../../packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

// The read-path gate's ENFORCEMENT leg, end to end: the write-side kind drift
// fixed by the contract-liveness audit means this guard had never run in
// production. Contract under test: two consecutive missing-path failures arm
// the gate; while armed, a read outside observed evidence is deflected to a
// [ReadPathGuard] err receipt (never executed); discovery evidence unlocks
// reads under observed directories, and observed-path reads pass exactly.

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

describe("read-path gate enforcement", () => {
  test("armed gate deflects unverified reads and discovery evidence unlocks them", async () => {
    const workspace = createTestWorkspace("read-path-gate");
    const sessionId = "read-gate-session";
    try {
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(join(workspace, "src/present.ts"), "export const present = true;\n", "utf8");
      writeFileSync(join(workspace, "docs/notes.md"), "release notes\n", "utf8");

      const runtime = createRuntimeFixture();
      const tool = createCompactReadTool({ cwd: workspace, runtime });

      // Not armed: a read of an existing file passes untouched. A successful
      // read records discovery evidence for its own directory, so the gated
      // attempts below use a DIFFERENT directory (docs/) that has no evidence.
      const beforeArm = await executeRead(tool, sessionId, "src/present.ts");
      expect(beforeArm.outcomeKind).not.toBe("err");
      expect(beforeArm.text).toContain("export const present = true;");

      // Arm through the ops verb (the vocabulary-aligned type the analyzer reads).
      runtime.ops.tools.readPath.gateArmed({
        sessionId,
        payload: {
          consecutiveMissingPathFailures: 2,
          failedPaths: ["missing-a.ts", "missing-b.ts"],
        },
      });

      // Armed + no discovery evidence for docs/: even an EXISTING file there
      // is deflected — the gate demands discovery first; the read must not run.
      const deflected = await executeRead(tool, sessionId, "docs/notes.md");
      expect(deflected.outcomeKind).toBe("err");
      expect(deflected.text).toContain("[ReadPathGuard]");
      expect(deflected.text).toContain("2 consecutive path-not-found failures");

      // Discovery evidence for the directory unlocks reads beneath it.
      runtime.ops.tools.readPath.discoveryObserved({
        sessionId,
        payload: { observedPaths: [], observedDirectories: ["docs"] },
      });
      const unlocked = await executeRead(tool, sessionId, "docs/notes.md");
      expect(unlocked.outcomeKind).not.toBe("err");
      expect(unlocked.text).toContain("release notes");

      // Paths outside the observed evidence stay gated.
      const stillGated = await executeRead(tool, sessionId, "lib/other.ts");
      expect(stillGated.outcomeKind).toBe("err");
      expect(stillGated.text).toContain("[ReadPathGuard]");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
