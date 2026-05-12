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
      existsSync(join(repoRoot, "packages/brewva-substrate/src/turn/provider-stream.ts")),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, "packages/brewva-substrate/src/provider/fetch-provider-driver.ts")),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, "packages/brewva-gateway/src/hosted/internal/provider/stream.ts")),
    ).toBe(true);
  });

  test("context status is numeric plus forced compaction, not exported pressure levels", () => {
    const contextTypes = readRepoFile("packages/brewva-runtime/src/domain/context/types.ts");
    const contextSurface = readRepoFile(
      "packages/brewva-runtime/src/domain/context/runtime-surface.ts",
    );
    const contextApi = readRepoFile("packages/brewva-runtime/src/domain/context/api.ts");
    const publicRuntime = readRepoFile("packages/brewva-runtime/src/public/index.ts");

    for (const source of [contextTypes, contextSurface, contextApi, publicRuntime]) {
      expect(source).not.toContain("ContextPressureLevel");
      expect(source).not.toContain("ContextPressureStatus");
      expect(source).not.toContain("getPressureStatus");
      expect(source).not.toContain("getPressureLevel");
    }
    expect(contextTypes).toContain("tokensUntilForcedCompact");
    expect(contextTypes).toContain("forcedCompaction");
    expect(contextTypes).not.toMatch(/level:\s/u);

    const sessionWire = readRepoFile("packages/brewva-runtime/src/domain/sessions/wire.ts");
    const gatewayProtocol = readRepoFile("packages/brewva-gateway/src/protocol/validate.ts");
    for (const source of [sessionWire, gatewayProtocol]) {
      expect(source).not.toContain("ContextPressureView");
      expect(source).not.toContain("contextPressure");
    }
    expect(sessionWire).toContain("contextStatus?: ContextStatusView");
  });

  test("context budget config exposes dynamic tail and cooldown bypass naming", () => {
    const configTypes = readRepoFile("packages/brewva-runtime/src/config/types.ts");
    const configDefaults = readRepoFile("packages/brewva-runtime/src/config/defaults.ts");
    const configNormalizer = readRepoFile(
      "packages/brewva-runtime/src/config/normalize-infrastructure.ts",
    );
    const contextBudget = readRepoFile("packages/brewva-runtime/src/domain/context/budget.ts");

    for (const source of [configTypes, configDefaults, configNormalizer, contextBudget]) {
      expect(source).toContain("dynamicTail");
      expect(source).toContain("cooldownBypassPercent");
      expect(source).not.toContain("contextBudget.injection");
      expect(source).not.toContain("pressureBypassPercent");
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

  test("deleted cognitive control surfaces stay deleted", () => {
    const removedDeliberationPackagePath = ["packages", ["brewva", "deliberation"].join("-")].join(
      "/",
    );

    const deletedPaths = [
      "packages/brewva-runtime/src/domain/context/injection.ts",
      "packages/brewva-runtime/src/domain/context/injection-orchestrator.ts",
      "packages/brewva-runtime/src/domain/context/context-supplemental-budget.ts",
      "packages/brewva-runtime/src/domain/context/provider.ts",
      "packages/brewva-runtime/src/domain/context/skill-routing.ts",
      "packages/brewva-runtime/src/domain/context/tool-output-distilled.ts",
      "packages/brewva-recall/src/context/provider.ts",
      "packages/brewva-gateway/src/hosted/internal/session/context-composer.ts",
      "packages/brewva-gateway/src/hosted/internal/session/context-composer-governance.ts",
      "packages/brewva-gateway/src/hosted/internal/session/context-composer-supplemental.ts",
      "packages/brewva-gateway/src/hosted/internal/session/context-composer-support.ts",
      "packages/brewva-gateway/src/hosted/internal/session/context-supplemental.ts",
      "packages/brewva-gateway/src/hosted/internal/session/hosted-context-injection-pipeline.ts",
      "packages/brewva-gateway/src/hosted/internal/session/skill-first.ts",
      "packages/brewva-tools/src/families/workflow/skill-load.ts",
      "packages/brewva-tools/src/families/workflow/skill-complete.ts",
      "packages/brewva-tools/src/families/memory/deliberation-memory.ts",
      "packages/brewva-tools/src/families/memory/narrative-memory.ts",
      "packages/brewva-tools/src/families/memory/optimization-continuity.ts",
      removedDeliberationPackagePath,
    ];

    expect(deletedPaths.filter((path) => existsSync(join(repoRoot, path)))).toEqual([]);
  });

  test("hosted dynamic context does not reintroduce a typed admission composer", () => {
    const gatewayHostedContextSources = [
      ...collectSourceFiles("packages/brewva-gateway/src/hosted/internal/thread-loop/context"),
      ...collectSourceFiles("packages/brewva-gateway/src/hosted/internal/thread-loop/evidence"),
      ...collectSourceFiles("packages/brewva-gateway/src/hosted/internal/session/tools"),
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    for (const forbiddenTerm of [
      "ContextSourceProvider",
      "ContextBlockCategory",
      "ContextBlockProvenance",
      "GuardedSupplemental",
      "applyGovernanceBudgetCap",
      "resolveSupplementalContextBlocks",
      "narrativeRatio",
      "laneReason",
      "familyId",
    ]) {
      expect(gatewayHostedContextSources).not.toContain(forbiddenTerm);
    }
  });

  test("replay paths consume stored compaction summaries without model regeneration", () => {
    const replaySources = [
      "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
      "packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts",
      "packages/brewva-runtime/src/domain/sessions/session-lifecycle.ts",
      "packages/brewva-runtime/src/domain/sessions/session-hydration-coordinator.ts",
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

  test("project guidance does not send agents to deleted cognitive control surfaces", () => {
    const projectGuidance = [
      readRepoFile("skills/project/shared/source-map.md"),
      readRepoFile("skills/project/shared/package-boundaries.md"),
    ].join("\n");
    const removedGuidanceTerms = [
      "packages/brewva-runtime/src/domain/context/arena.ts",
      "packages/brewva-runtime/src/domain/context/injection-orchestrator.ts",
      "packages/brewva-runtime/src/domain/context/injection.ts",
      "packages/brewva-runtime/src/domain/context/provider.ts",
      "packages/brewva-runtime/src/domain/context/context-supplemental-budget.ts",
      "packages/brewva-runtime/src/domain/context/skill-routing.ts",
      "packages/brewva-recall/src/context",
      "packages/brewva-skill-broker",
      "@brewva/brewva-skill-broker",
    ];

    for (const removedTerm of removedGuidanceTerms) {
      expect(projectGuidance).not.toContain(removedTerm);
    }
  });
});
