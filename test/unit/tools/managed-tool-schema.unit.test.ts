import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessTool, createReadSpansTool } from "@brewva/brewva-tools";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

describe("managed Brewva tool schemas", () => {
  test("read_spans exposes a canonical schema and still accepts aliased input", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-managed-tool-schema-"));
    const tool = createReadSpansTool();

    const parameters = tool.parameters as {
      anyOf?: unknown;
      allOf?: unknown;
      properties?: Record<string, unknown>;
      required?: string[];
      type?: unknown;
    };

    expect(parameters.type).toBe("object");
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    expect(parameters.properties?.file_path).toBeDefined();
    expect(parameters.properties?.filePath).toBeUndefined();
    expect(parameters.required).toEqual(["file_path", "spans"]);

    const result = await tool.execute(
      "tc-read-spans-managed-schema",
      {
        filePath: "missing.ts",
        spans: [{ start_line: 1, end_line: 2 }],
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(extractTextContent(result as { content: Array<{ type: string; text?: string }> })).toBe(
      `Error: File not found: ${join(workspace, "missing.ts")}`,
    );
  });

  test("manual alias schemas expose canonical keys while execution still accepts legacy aliases", async () => {
    const tool = createProcessTool();
    const parameters = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.sessionId).toBeDefined();
    expect(parameters.properties?.session_id).toBeUndefined();
    expect(parameters.properties?.timeout).toBeDefined();
    expect(parameters.properties?.timeout_ms).toBeUndefined();
    expect(parameters.required).toEqual(["action"]);

    const result = await tool.execute(
      "tc-process-managed-schema",
      {
        action: "poll",
        session_id: "missing-session",
        timeout_ms: 0,
      } as never,
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => "owner-session",
        },
      } as never,
    );

    expect(extractTextContent(result as { content: Array<{ type: string; text?: string }> })).toBe(
      "No session found for missing-session",
    );
  });
});
