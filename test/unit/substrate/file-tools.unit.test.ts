import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrewvaEditToolDefinition,
  createBrewvaReadToolDefinition,
  createBrewvaWriteToolDefinition,
} from "@brewva/brewva-substrate/tools";
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

async function captureError(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
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

  test("read tool rejects legacy file field without throwing", async () => {
    const workspace = createTestWorkspace("substrate-read-tool-legacy-file-field");
    const filePath = join(workspace, "notes.txt");
    writeFileSync(filePath, "alpha\nbeta\n", "utf8");

    const tool = createBrewvaReadToolDefinition(workspace);
    const result = await tool.execute(
      "tool-call-legacy-file",
      { file: "notes.txt" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    expect(extractText(result)).toContain("read rejected: path is required");
    expect(result.outcome.kind).toBe("err");

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
    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind !== "ok") {
      throw new Error("Expected edit result to be ok");
    }
    expect(result.outcome.value.firstChangedLine).toBe(1);
    expect(result.outcome.value.diff).toContain("-1 const alpha = 1;");
    expect(result.outcome.value.diff).toContain("+1 const alpha = 10;");

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

  test("write tool keeps aborted mutations inside the file queue until checkpoints complete", async () => {
    const workspace = createTestWorkspace("substrate-write-abort-tool");
    const controller = new AbortController();
    let attemptedWrite = false;
    const tool = createBrewvaWriteToolDefinition(workspace, {
      operations: {
        async mkdir() {
          controller.abort();
        },
        async writeFile() {
          attemptedWrite = true;
        },
      },
    });

    const error = await captureError(
      tool.execute(
        "tool-call-4",
        {
          path: "abort/output.txt",
          content: "must not write",
        },
        controller.signal,
        undefined,
        undefined as never,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Operation aborted");
    expect(attemptedWrite).toBe(false);

    cleanupTestWorkspace(workspace);
  });

  test("edit tool does not release an aborted file mutation before the read checkpoint", async () => {
    const workspace = createTestWorkspace("substrate-edit-abort-tool");
    const controller = new AbortController();
    let attemptedWrite = false;
    const tool = createBrewvaEditToolDefinition(workspace, {
      operations: {
        async access() {},
        async readFile() {
          controller.abort();
          return Buffer.from("const value = 1;\n", "utf8");
        },
        async writeFile() {
          attemptedWrite = true;
        },
      },
    });

    const error = await captureError(
      tool.execute(
        "tool-call-5",
        {
          path: "src/example.ts",
          edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
        },
        controller.signal,
        undefined,
        undefined as never,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Operation aborted");
    expect(attemptedWrite).toBe(false);

    cleanupTestWorkspace(workspace);
  });
});
