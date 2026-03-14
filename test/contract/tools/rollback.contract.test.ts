import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createRollbackLastPatchTool } from "@brewva/brewva-tools";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

describe("rollback_last_patch contract", () => {
  test("restores tracked edits", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-tool-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      args: { file_path: "src/example.ts" },
    });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 2;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      channelSuccess: true,
    });

    const rollbackTool = createRollbackLastPatchTool({ runtime });
    const result = await rollbackTool.execute(
      "tc-rollback",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);

    expect(text).toContain("Rolled back patch set");
    expect(readFileSync(join(workspace, "src/example.ts"), "utf8")).toBe("export const n = 1;\n");
  });

  test("reports when no tracked patch set is available for the session", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-tool-empty-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9-empty";

    const rollbackTool = createRollbackLastPatchTool({ runtime });
    const result = await rollbackTool.execute(
      "tc-rollback-empty",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("No tracked patch set is available");
  });
});
