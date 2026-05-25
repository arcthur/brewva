import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("runtime model attention boundary fitness", () => {
  test("exposes materialization observation without adding a runtime root port", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const modelPort = readRepoFile("packages/brewva-runtime/src/runtime/model/port.ts");
    const runtimeRoot = runtimeApi.match(/export interface BrewvaRuntime \{(?<body>[\s\S]*?)\n\}/u)
      ?.groups?.["body"];

    expect(runtimeApi).toContain("ModelObservePort");
    expect(modelPort).toContain("export interface ModelObservePort");
    expect(modelPort).toContain("readonly observe: ModelObservePort");
    expect(modelPort).toContain("sourceEventIds: readonly EventId[]");
    expect(modelPort).toContain("admittedBlockIds: readonly string[]");
    expect(modelPort).toContain("droppedAdvisoryBlockIds: readonly string[]");
    expect(runtimeRoot).toContain("readonly model: ModelPort;");
    expect(runtimeRoot).not.toContain("attention");
    expect(runtimeRoot).not.toContain("observe");
  });

  test("keeps runtime model materialization independent from hosted salience owners", () => {
    const model = readRepoFile("packages/brewva-runtime/src/runtime/model/impl.ts");

    expect(model).not.toMatch(/@brewva\/brewva-gateway|@brewva\/brewva-recall/u);
    expect(model).not.toMatch(/workbench|salience|ranking/u);
    expect(model).toContain("MAX_MATERIALIZATION_OBSERVATIONS");
    expect(model).toContain("appendMaterializationObservation");
  });
});
