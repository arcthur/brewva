import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { assertCliSuccess, runCliSync } from "../../helpers/cli.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("cli contract: undo", () => {
  test("undo restores the latest tracked patch set through the CLI surface", () => {
    const workspace = createTestWorkspace("contract-undo");
    const filePath = join(workspace, "undo_fixture.txt");
    const baseline = "BASELINE\n";
    const changed = "CHANGED\n";
    writeFileSync(filePath, baseline, "utf8");

    try {
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionId = "system-undo-session";
      runtime.context.onTurnStart(sessionId, 1);
      runtime.tools.trackCallStart({
        sessionId,
        toolCallId: "tc-edit",
        toolName: "edit",
        args: { file_path: "undo_fixture.txt" },
      });
      writeFileSync(filePath, changed, "utf8");
      runtime.tools.trackCallEnd({
        sessionId,
        toolCallId: "tc-edit",
        toolName: "edit",
        channelSuccess: true,
      });

      const undo = runCliSync(workspace, ["--undo", "--session", sessionId]);
      assertCliSuccess(undo, "system-undo");
      expect(undo.stdout).toContain("Rolled back");
      expect(readFileSync(filePath, "utf8")).toBe(baseline);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
