import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillLoadTool } from "@brewva/brewva-tools";

export type ToolExecutionContext = Parameters<ReturnType<typeof createSkillLoadTool>["execute"]>[4];

export function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

export function fakeContext(sessionId: string): ToolExecutionContext {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  } as unknown as ToolExecutionContext;
}

export function mergeContext(
  sessionId: string,
  extra: Record<string, unknown>,
): ToolExecutionContext {
  return {
    ...fakeContext(sessionId),
    ...extra,
  } as unknown as ToolExecutionContext;
}

export function createScheduleToolRuntime(prefix: string): BrewvaRuntime {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "brewva.json"),
    JSON.stringify(
      {
        schedule: {
          enabled: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return new BrewvaRuntime({ cwd: workspace });
}
