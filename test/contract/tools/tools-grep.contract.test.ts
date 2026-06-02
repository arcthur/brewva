import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "@brewva/brewva-tools/navigation";
import { createBundledToolRuntime, createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

describe("grep managed tool", () => {
  test("records source snapshots for matched lines under scoped runtime capabilities", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-"));
    writeFileSync(
      join(workspace, "example.ts"),
      ["export const approval = 'approval-and-rollback';", ""].join("\n"),
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-source-snapshot",
      {
        query: "approval-and-rollback",
        paths: ["."],
      },
      undefined,
      undefined,
      fakeContext("tc-grep-source-snapshot"),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = toolOutcomePayload(result) as { snapshots?: Array<{ id: string }> };
    expect(text).toMatch(/snapshot: snap_/u);
    expect(details.snapshots).toHaveLength(1);
  });
});
