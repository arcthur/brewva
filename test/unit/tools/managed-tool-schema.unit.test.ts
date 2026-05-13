import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessTool } from "@brewva/brewva-tools/execution";
import { createReadSpansTool } from "@brewva/brewva-tools/navigation";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

describe("managed Brewva tool schemas", () => {
  test("read_spans exposes a canonical schema without legacy alias paths", async () => {
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
    expect(Object.hasOwn(parameters, "anyOf")).toBe(false);
    expect(Object.hasOwn(parameters, "allOf")).toBe(false);
    expect(Object.hasOwn(parameters.properties ?? {}, "file_path")).toBe(true);
    expect(Object.hasOwn(parameters.properties ?? {}, "filePath")).toBe(false);
    expect(parameters.required).toEqual(["file_path", "spans"]);

    const result = await tool.execute(
      "tc-read-spans-managed-schema",
      {
        file_path: "missing.ts",
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

  test("manual alias schemas expose canonical keys without legacy execution aliases", async () => {
    const tool = createProcessTool();
    const parameters = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.hasOwn(parameters.properties ?? {}, "action")).toBe(true);
    expect(Object.hasOwn(parameters.properties ?? {}, "sessionId")).toBe(true);
    expect(Object.hasOwn(parameters.properties ?? {}, "session_id")).toBe(false);
    expect(Object.hasOwn(parameters.properties ?? {}, "timeout")).toBe(true);
    expect(Object.hasOwn(parameters.properties ?? {}, "timeout_ms")).toBe(false);
    expect(parameters.required).toEqual(["action"]);

    const result = await tool.execute(
      "tc-process-managed-schema",
      {
        action: "poll",
        sessionId: "missing-session",
        timeout: 0,
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
