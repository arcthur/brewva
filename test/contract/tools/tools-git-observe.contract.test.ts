import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitStatusTool } from "@brewva/brewva-tools/navigation";
import { createBundledToolRuntime, createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

describe("git observe managed tools", () => {
  test("git_status workdir rejection includes the rejected path and recovery guidance", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "brewva-git-status-")));
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "brewva-git-outside-")));
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGitStatusTool({ runtime });

    const result = await tool.execute(
      "tc-git-status-workdir-rejection",
      { workdir: outsideRoot },
      undefined,
      undefined,
      fakeContext("git-status-workdir-rejection"),
    );

    expect(result.outcome.kind).toBe("err");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain(`git_status rejected: workdir escapes target roots (${workspace}).`);
    expect(text).toContain(`Rejected workdir: ${outsideRoot}`);
    expect(text).toContain("Stay inside a target root");
  });
});
