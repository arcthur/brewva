import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime, type BrewvaConfig } from "@brewva/brewva-runtime";

export function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

export function fakeContext(sessionId: string, cwd: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

export function workspaceWithSampleFiles(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src/a.ts"),
    "export const valueA = 1;\nexport const valueAX = valueA + 2;\n",
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/b.ts"),
    "import { valueA } from './a';\nexport const valueB = valueA + 1;\n",
    "utf8",
  );
  writeFileSync(join(workspace, "src/c.ts"), "export const valueC = 3;\n", "utf8");
  return workspace;
}

export function createRuntime(workspace: string, config?: BrewvaConfig): BrewvaRuntime {
  const runtimeConfig = structuredClone(config ?? DEFAULT_BREWVA_CONFIG);
  runtimeConfig.infrastructure.events.level = "debug";
  return new BrewvaRuntime({ cwd: workspace, config: runtimeConfig });
}

export function getParallelReadPayloads(
  runtime: BrewvaRuntime,
  sessionId: string,
): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  for (const event of runtime.events.query(sessionId, { type: "tool_parallel_read" })) {
    if (!event.payload) continue;
    payloads.push(event.payload as unknown as Record<string, unknown>);
  }
  return payloads;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

export function expectTelemetryCountersConsistent(payload: Record<string, unknown>): void {
  const scannedFiles = toFiniteNumber(payload.scannedFiles);
  const loadedFiles = toFiniteNumber(payload.loadedFiles);
  const failedFiles = toFiniteNumber(payload.failedFiles);
  expect(scannedFiles).toBe(loadedFiles + failedFiles);
}
