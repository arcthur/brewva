import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";

export type ToolExecutionContext = Parameters<BrewvaToolDefinition["execute"]>[4];

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

export function createScheduleToolRuntime(prefix: string): BrewvaHostedRuntimePort {
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
  return createBrewvaRuntime({ cwd: workspace }).hosted;
}
