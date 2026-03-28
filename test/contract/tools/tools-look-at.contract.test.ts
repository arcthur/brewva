import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createLookAtTool } from "@brewva/brewva-tools";
import { createRuntimeConfig } from "../../helpers/runtime.js";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function createScopedLookAtTool(sessionId: string, filePath: string) {
  const cwd = dirname(filePath);
  const runtime = new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
  runtime.task.setSpec(sessionId, {
    schema: "brewva.task.v1",
    goal: "Inspect an explicitly targeted file.",
    targets: {
      files: [filePath],
    },
  });
  return {
    tool: createLookAtTool({ runtime }),
    context: {
      cwd,
      sessionManager: {
        getSessionId() {
          return sessionId;
        },
      },
    } as never,
  };
}

describe("look_at tool", () => {
  test("returns unavailable when no high-confidence match exists", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-look-at-unavailable-"));
    const filePath = join(workspace, "sample.ts");
    writeFileSync(
      filePath,
      ["export const alpha = 1;", "export const beta = 2;", "export const gamma = 3;"].join("\n"),
      "utf8",
    );

    const { tool, context } = createScopedLookAtTool("tc-look-at-unavailable", filePath);
    const result = await tool.execute(
      "tc-look-at-unavailable",
      {
        file_path: filePath,
        goal: "trace transaction rollback boundary",
      },
      undefined,
      undefined,
      context,
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("look_at unavailable");
    expect(text).toContain("next_step=");
    expect(text.includes("export const alpha")).toBe(false);
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("inconclusive");
    expect(details?.reason).toBe("no_high_confidence_match");
  });

  test("returns unavailable when goal has no usable keywords", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-look-at-keywords-"));
    const filePath = join(workspace, "sample.ts");
    writeFileSync(filePath, "export const alpha = 1;\n", "utf8");

    const { tool, context } = createScopedLookAtTool("tc-look-at-keywords", filePath);
    const result = await tool.execute(
      "tc-look-at-keywords",
      {
        file_path: filePath,
        goal: "a b c",
      },
      undefined,
      undefined,
      context,
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("inconclusive");
    expect(details?.reason).toBe("goal_keywords_insufficient");
  });

  test("returns unavailable when goal is non-ascii", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-look-at-unicode-"));
    const filePath = join(workspace, "sample.ts");
    writeFileSync(filePath, ["const 回滚边界 = true;", "const alpha = 1;"].join("\n"), "utf8");

    const { tool, context } = createScopedLookAtTool("tc-look-at-unicode", filePath);
    const result = await tool.execute(
      "tc-look-at-unicode",
      {
        file_path: filePath,
        goal: "确认回滚边界逻辑",
      },
      undefined,
      undefined,
      context,
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("inconclusive");
    expect(details?.reason).toBe("unsupported_goal_language");
  });
});
