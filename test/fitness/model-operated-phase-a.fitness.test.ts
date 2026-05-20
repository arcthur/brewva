import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(repoRelativePath: string): string {
  return readFileSync(join(repoRoot, repoRelativePath), "utf8");
}

function collectSourceFiles(relativeDir: string): string[] {
  const root = join(repoRoot, relativeDir);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  if (existsSync(root)) {
    walk(root);
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function relativePath(absolutePath: string): string {
  return absolutePath.replace(`${repoRoot}/`, "");
}

describe("model-operated Phase A architecture guard", () => {
  test("gateway is the only package that executes provider model calls", () => {
    const inspectedRoots = ["packages/brewva-runtime/src", "packages/brewva-substrate/src"];
    const forbiddenImports = [
      "@brewva/brewva-provider-core/stream",
      "../provider/fetch-provider-driver.js",
      "./provider-stream.js",
    ];
    const offenders: Array<{ file: string; import: string }> = [];

    for (const file of inspectedRoots.flatMap(collectSourceFiles)) {
      const source = readFileSync(file, "utf8");
      for (const importText of forbiddenImports) {
        if (source.includes(importText)) {
          offenders.push({ file: relativePath(file), import: importText });
        }
      }
      if (source.includes("createBrewvaTurnProviderStreamFunction")) {
        offenders.push({
          file: relativePath(file),
          import: "createBrewvaTurnProviderStreamFunction",
        });
      }
      if (source.includes("createFetchProviderCompletionDriver")) {
        offenders.push({
          file: relativePath(file),
          import: "createFetchProviderCompletionDriver",
        });
      }
    }

    expect(offenders).toEqual([]);
    expect(
      existsSync(join(repoRoot, "packages/brewva-gateway/src/hosted/internal/provider/stream.ts")),
    ).toBe(true);
  });

  test("context status is numeric plus forced compaction, not exported pressure levels", () => {
    const contextTypes = readRepoFile("packages/brewva-runtime/src/protocol.ts");
    const publicRuntime = readRepoFile("packages/brewva-runtime/src/public/index.ts");

    for (const source of [contextTypes, publicRuntime]) {
      expect(source).not.toContain("ContextPressureLevel");
      expect(source).not.toContain("ContextPressureStatus");
      expect(source).not.toContain("getPressureStatus");
      expect(source).not.toContain("getPressureLevel");
    }
    const gatewayProtocol = readRepoFile("packages/brewva-gateway/src/protocol/validate.ts");
    for (const source of [gatewayProtocol]) {
      expect(source).not.toContain("ContextPressureView");
      expect(source).not.toContain("contextPressure");
    }
    expect(gatewayProtocol).toContain("tokensUntilForcedCompact");
    expect(gatewayProtocol).toContain("forcedCompaction");
  });

  test("context budget config exposes contracted threshold and dynamic-tail naming", () => {
    const configTypes = readRepoFile("packages/brewva-runtime/src/config/types.ts");
    const configDefaults = readRepoFile("packages/brewva-runtime/src/config/defaults.ts");
    const configNormalizer = readRepoFile(
      "packages/brewva-runtime/src/config/normalize-infrastructure.ts",
    );

    for (const source of [configTypes, configDefaults, configNormalizer]) {
      expect(source).toContain("dynamicTailTokens");
      expect(source).toContain("predictedTurnGrowthTokens");
      expect(source).toContain("headroomTokens");
      expect(source).not.toContain("contextBudget.injection");
      expect(source).not.toContain("pressureBypassPercent");
      expect(source).not.toContain("cooldownBypassPercent");
    }
  });

  test("forced compaction gate allowlist stays compact-only", () => {
    const controlPlaneTools = readRepoFile(
      "packages/brewva-runtime/src/security/control-plane-tools.ts",
    );

    expect(controlPlaneTools).toContain(
      'export const CONTEXT_CRITICAL_ALLOWED_TOOLS = ["workbench_compact"];',
    );
    expect(controlPlaneTools).not.toContain("config.infrastructure.contextBudget");
    expect(controlPlaneTools).not.toContain("alwaysAllowedTools:");
  });

  test("replay paths consume stored compaction summaries without model regeneration", () => {
    const replaySources = [
      "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
      "packages/brewva-runtime/src/runtime/model/model.ts",
    ]
      .map(readRepoFile)
      .join("\n");

    for (const forbiddenTerm of [
      "createHostedLlmCompactionSummaryGenerator",
      "BrewvaCompactionSummaryGenerator",
      "compactionSummaryGenerator",
      "completionClient",
      "createHostedProviderCompletionClient",
    ]) {
      expect(replaySources).not.toContain(forbiddenTerm);
    }
  });
});
