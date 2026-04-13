import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrewvaEditToolDefinition,
  createBrewvaReadToolDefinition,
  createBrewvaWriteToolDefinition,
} from "@brewva/brewva-substrate";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: {
  content: Array<{
    type: string;
    text?: string;
  }>;
}): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

describe("substrate file tools", () => {
  test("read tool returns bounded content with a continuation footer", async () => {
    const workspace = createTestWorkspace("substrate-read-tool");
    const filePath = join(workspace, "notes.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n", "utf8");

    const tool = createBrewvaReadToolDefinition(workspace);
    const result = await tool.execute(
      "tool-call-1",
      { path: "notes.txt", limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );

    expect(extractText(result)).toBe(
      "alpha\nbeta\n\n[3 more lines in file. Use offset=3 to continue.]",
    );

    cleanupTestWorkspace(workspace);
  });

  test("edit tool applies exact replacements against the original content and returns diff details", async () => {
    const workspace = createTestWorkspace("substrate-edit-tool");
    const filePath = join(workspace, "src", "example.ts");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      filePath,
      "const alpha = 1;\nconst beta = 2;\nconst gamma = alpha + beta;\n",
      "utf8",
    );

    const tool = createBrewvaEditToolDefinition(workspace);
    const result = await tool.execute(
      "tool-call-2",
      {
        path: "src/example.ts",
        edits: [
          { oldText: "const alpha = 1;", newText: "const alpha = 10;" },
          { oldText: "const beta = 2;", newText: "const beta = 20;" },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(readFileSync(filePath, "utf8")).toContain("const alpha = 10;");
    expect(readFileSync(filePath, "utf8")).toContain("const beta = 20;");
    expect(extractText(result)).toContain("Successfully replaced 2 block(s)");
    expect(result.details?.firstChangedLine).toBe(1);
    expect(result.details?.diff).toContain("-1 const alpha = 1;");
    expect(result.details?.diff).toContain("+1 const alpha = 10;");

    cleanupTestWorkspace(workspace);
  });

  test("write tool creates parent directories and writes the target file", async () => {
    const workspace = createTestWorkspace("substrate-write-tool");
    const filePath = join(workspace, "nested", "deep", "output.txt");

    const tool = createBrewvaWriteToolDefinition(workspace);
    const result = await tool.execute(
      "tool-call-3",
      {
        path: "nested/deep/output.txt",
        content: "hello from substrate",
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(readFileSync(filePath, "utf8")).toBe("hello from substrate");
    expect(extractText(result)).toContain("Successfully wrote");

    cleanupTestWorkspace(workspace);
  });
});
