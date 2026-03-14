import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAstGrepTools } from "@brewva/brewva-tools";
import {
  createRuntime,
  extractTextContent,
  fakeContext,
  getParallelReadPayloads,
  workspaceWithSampleFiles,
} from "./tools-parallel-read.helpers.js";

describe("tool parallel read ast-grep fallbacks", () => {
  test("ast_grep_search returns unavailable when sg execution fails", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-file-cwd-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-astgrep-file-cwd";
    const tools = createAstGrepTools();
    const astGrepSearch = tools.find((tool) => tool.name === "ast_grep_search");
    expect(astGrepSearch).toBeDefined();

    const fileCwd = join(workspace, "src/a.ts");
    const result = await astGrepSearch!.execute(
      "tc-astgrep-search-file-cwd",
      {
        pattern: "valueA",
        lang: "ts",
      },
      undefined,
      undefined,
      fakeContext(sessionId, fileCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("unavailable");
    expect(text).toContain("next_step=");
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("fail");
    expect(details?.reason).toBe("ast_grep_unavailable");
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });

  test("ast_grep_replace returns unavailable when sg execution fails", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-replace-fallback-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-astgrep-replace-fallback";
    const tools = createAstGrepTools();
    const astGrepReplace = tools.find((tool) => tool.name === "ast_grep_replace");
    expect(astGrepReplace).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const result = await astGrepReplace!.execute(
      "tc-astgrep-replace-fallback",
      {
        pattern: "valueA",
        rewrite: "valueA2",
        lang: "ts",
        dryRun: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("unavailable");
    expect(text).toContain("next_step=");
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("fail");
    expect(details?.reason).toBe("ast_grep_unavailable");
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });

  test("ast_grep_replace unavailable path does not mutate files", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-replace-apply-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-astgrep-replace-apply";
    const tools = createAstGrepTools();
    const astGrepReplace = tools.find((tool) => tool.name === "ast_grep_replace");
    expect(astGrepReplace).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const targetFile = join(workspace, "src/a.ts");
    const result = await astGrepReplace!.execute(
      "tc-astgrep-replace-apply",
      {
        pattern: "valueA",
        rewrite: "valueAUpdated",
        lang: "ts",
        dryRun: false,
        paths: [join(workspace, "src")],
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("unavailable");
    expect(readFileSync(targetFile, "utf8").includes("valueAUpdated")).toBe(false);
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });
});
