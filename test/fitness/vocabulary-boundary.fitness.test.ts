import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  ProviderCacheCapability as ProviderCoreCacheCapability,
  ProviderCacheRenderResult as ProviderCoreCacheRenderResult,
} from "@brewva/brewva-provider-core/contracts";
import type {
  ProviderCacheCapability as VocabularyProviderCacheCapability,
  ProviderCacheRenderState as VocabularyProviderCacheRenderState,
} from "@brewva/brewva-vocabulary/context";

const repoRoot = resolve(import.meta.dir, "../..");
const requiredVocabularySubpaths = [
  "./context",
  "./delegation",
  "./events",
  "./fitness",
  "./goal",
  "./harness",
  "./iteration",
  "./outcome",
  "./plan-map",
  "./rcr",
  "./reduction",
  "./review",
  "./schedule",
  "./session",
  "./task",
  "./tool-invocations",
  "./user-model",
  "./wire",
  "./workbench",
] as const;
const requiredVocabularyInternalModules = [
  "context",
  "delegation",
  "events",
  "fitness",
  "harness",
  "iteration",
  "rcr",
  "reduction",
  "review",
  "schedule",
  "session",
  "shared",
  "skills",
  "task",
  "tool-invocations",
  "wire",
  "wire-validation",
  "work-card",
  "workbench",
] as const;
// Raised 800 -> 900 (Finding P1, post-merge review): `deriveLatestTreeMutationAt`
// — the single shared tree-mutation-timestamp fold — is homed in `iteration.ts`
// beside the sibling touched-file-universe derivations it shares a predicate
// with (`BARE_WRITE_TOOL_NAMES`, `extractWriteInvocationPaths`,
// `deriveFreshTouchedFileUniverse`), replacing two DUPLICATED inline reductions
// in the CLI review-debt read and the requirement-fitness assembler. That is
// cohesive single-homing, not cathedral-building — the module stays domain-sliced
// (event vocabulary + its projections), well under the retired body.ts scale.
const vocabularyInternalLineBudget = 900;
const allowedVocabularyBrewvaDeps = ["@brewva/brewva-std"] as const;

type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type Assert<T extends true> = T;
type _ProviderCacheCapabilityBridge = Assert<
  Extends<ProviderCoreCacheCapability, VocabularyProviderCacheCapability>
>;
type _VocabularyProviderCacheCapabilityBridge = Assert<
  Extends<VocabularyProviderCacheCapability, ProviderCoreCacheCapability>
>;
type _ProviderCacheRenderBridge = Assert<
  Extends<ProviderCoreCacheRenderResult, VocabularyProviderCacheRenderState>
>;
type _VocabularyProviderCacheRenderBridge = Assert<
  Extends<VocabularyProviderCacheRenderState, ProviderCoreCacheRenderResult>
>;

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readRepoFile(path));
}

function collectSourceFiles(path: string): string[] {
  const root = resolve(repoRoot, path);
  const files: string[] = [];
  if (!existsSync(root)) return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  walk(root);
  return files.toSorted();
}

function packageDirs(): string[] {
  return readdirSync(resolve(repoRoot, "packages"))
    .map((name) => resolve(repoRoot, "packages", name))
    .filter((path) => statSync(path).isDirectory())
    .toSorted((left, right) => left.localeCompare(right));
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function lineCount(source: string): number {
  return source.split("\n").length;
}

describe("vocabulary boundary fitness", () => {
  test("vocabulary is a leaf package with explicit subpaths and no root export", () => {
    const packageJson = readJson("packages/brewva-vocabulary/package.json") as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      name?: string;
    };

    expect(packageJson.name).toBe("@brewva/brewva-vocabulary");
    expect(Object.hasOwn(packageJson.exports ?? {}, ".")).toBe(false);
    for (const subpath of requiredVocabularySubpaths) {
      expect(Object.hasOwn(packageJson.exports ?? {}, subpath), subpath).toBe(true);
    }
    expect(
      Object.keys(packageJson.exports ?? {})
        .filter((subpath) => subpath !== ".")
        .toSorted(),
    ).toEqual([...requiredVocabularySubpaths].toSorted());

    const brewvaDeps = Object.keys(packageJson.dependencies ?? {}).filter((name) =>
      name.startsWith("@brewva/"),
    );
    expect(brewvaDeps).toEqual([...allowedVocabularyBrewvaDeps]);
  });

  test("runtime remains vocabulary-independent", () => {
    const packageJson = readJson("packages/brewva-runtime/package.json") as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).not.toHaveProperty("@brewva/brewva-vocabulary");

    const offenders = collectSourceFiles("packages/brewva-runtime/src")
      .filter((file) => readFileSync(file, "utf8").includes("@brewva/brewva-vocabulary"))
      .map(repoPath);

    expect(offenders).toEqual([]);
  });

  test("runtime protocol alias is deleted instead of exporting product vocabulary barrels", () => {
    const runtimePackage = readJson("packages/brewva-runtime/package.json") as {
      exports?: Record<string, unknown>;
    };

    expect(runtimePackage.exports ?? {}).not.toHaveProperty("./protocol");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol.ts"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol"))).toBe(false);
  });

  test("vocabulary subpaths stay curated instead of wildcarding the internal body", () => {
    const offenders = requiredVocabularySubpaths.flatMap((subpath) => {
      const sourcePath = `packages/brewva-vocabulary/src/${subpath.slice(2)}.ts`;
      const source = readRepoFile(sourcePath);
      const exportCount = source.match(/^  [A-Za-z0-9_]+,?$/gmu)?.length ?? 0;
      const sourceLineCount = lineCount(source);
      const errors: string[] = [];

      if (/export\s+\*/u.test(source)) {
        errors.push(`${sourcePath} uses wildcard exports`);
      }
      if (source.includes("./internal/body.js")) {
        errors.push(`${sourcePath} imports the retired internal body`);
      }
      // The coupled world rewind RFC added four real cross-package names to
      // the session domain (the checkpoint event type constant replacing raw
      // string literals at the emit/find sites, the `brewva.world.v1` block
      // schema, its minimal parse, and the `SessionWorldRestoreRecord` receipt
      // block the completion payload carries) — contract exports, not barrel
      // growth.
      if (exportCount > 104) {
        errors.push(`${sourcePath} exports ${exportCount} names`);
      }
      if (sourceLineCount > 140) {
        errors.push(`${sourcePath} has ${sourceLineCount} lines`);
      }
      return errors;
    });

    expect(offenders).toEqual([]);
  });

  test("vocabulary internals stay domain-sliced instead of rebuilding a body cathedral", () => {
    const retiredBodyPath = resolve(repoRoot, "packages/brewva-vocabulary/src/internal/body.ts");
    expect(existsSync(retiredBodyPath)).toBe(false);

    const offenders = requiredVocabularyInternalModules.flatMap((moduleName) => {
      const sourcePath = `packages/brewva-vocabulary/src/internal/${moduleName}.ts`;
      const absolutePath = resolve(repoRoot, sourcePath);
      const errors: string[] = [];

      if (!existsSync(absolutePath)) {
        return [`${sourcePath} is missing`];
      }
      const sourceLineCount = lineCount(readFileSync(absolutePath, "utf8"));
      if (sourceLineCount > vocabularyInternalLineBudget) {
        errors.push(`${sourcePath} has ${sourceLineCount} lines`);
      }
      return errors;
    });

    expect(offenders).toEqual([]);
  });

  test("class D helpers live with their consumers instead of vocabulary public subpaths", () => {
    const task = readRepoFile("packages/brewva-vocabulary/src/task.ts");
    const iteration = readRepoFile("packages/brewva-vocabulary/src/iteration.ts");
    const wire = readRepoFile("packages/brewva-vocabulary/src/wire.ts");
    const internalTask = readRepoFile("packages/brewva-vocabulary/src/internal/task.ts");
    const internalIteration = readRepoFile("packages/brewva-vocabulary/src/internal/iteration.ts");
    const internalWire = readRepoFile("packages/brewva-vocabulary/src/internal/wire.ts");

    expect(task).not.toContain("parseTaskSpec");
    expect(iteration).not.toMatch(
      /deriveTurnEffectCommitmentProjection|renderTurnConsequenceDigest/u,
    );
    expect(wire).not.toContain("buildTurnEnvelope");
    expect(internalTask).not.toMatch(/export\s+(?:type|function)\s+TaskSpecParseResult/u);
    expect(internalTask).not.toMatch(/export\s+function\s+parseTaskSpec/u);
    expect(internalIteration).not.toMatch(
      /export\s+function\s+(?:deriveTurnEffectCommitmentProjection|renderTurnConsequenceDigest)/u,
    );
    expect(internalWire).not.toMatch(/export\s+function\s+buildTurnEnvelope/u);
  });

  test("product packages do not import the runtime protocol vocabulary", () => {
    const offenders = packageDirs()
      .filter((dir) => !dir.endsWith("/brewva-runtime"))
      .flatMap((dir) =>
        collectSourceFiles(relative(repoRoot, resolve(dir, "src"))).flatMap((file) => {
          const source = readFileSync(file, "utf8");
          return /from\s+["']@brewva\/brewva-runtime\/protocol["']/u.test(source)
            ? [repoPath(file)]
            : [];
        }),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("consumer aliases reuse vocabulary unions instead of copying product literals", () => {
    const offenders: string[] = [];
    const checks: readonly { path: string; pattern: RegExp; message: string }[] = [
      {
        path: "packages/brewva-tools/src/contracts/subagent.ts",
        pattern: /export\s+type\s+SubagentResultMode\s*=\s*["']/u,
        message: "SubagentResultMode must alias DelegationResultMode",
      },
      {
        path: "packages/brewva-tools/src/utils/result.ts",
        pattern:
          /export\s+type\s+ToolTextOutcomeKind\s*=\s*["']ok["']\s*\|\s*["']err["']\s*\|\s*["']inconclusive["']/u,
        message: "ToolTextOutcomeKind must alias BrewvaOutcomeKind",
      },
      {
        path: "packages/brewva-cli/src/entry/acp-gateway-agent.ts",
        pattern: /managedToolMode\?:\s*["']hosted["']\s*\|\s*["']direct["']/u,
        message: "AcpGatewayStdioOptions.managedToolMode must use ManagedToolMode",
      },
      {
        path: "packages/brewva-cli/src/operator/inspect/report.ts",
        pattern: /managedToolMode(?:\?)?:\s*["']hosted["']\s*\|\s*["']direct["']/u,
        message: "inspect bootstrap managedToolMode must use ManagedToolMode",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/session/tools/tool-output-display.ts",
        pattern:
          /export\s+type\s+ToolDisplayVerdict\s*=\s*["']pass["']\s*\|\s*["']fail["']\s*\|\s*["']inconclusive["']/u,
        message: "ToolDisplayVerdict must alias OutcomeVerdict",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/context/evidence/ledger-writer.ts",
        pattern:
          /type\s+ToolOutcomeVerdict\s*=\s*["']pass["']\s*\|\s*["']fail["']\s*\|\s*["']inconclusive["']/u,
        message: "ToolOutcomeVerdict must alias OutcomeVerdict",
      },
      {
        path: "packages/brewva-gateway/src/protocol/turn-envelope.ts",
        pattern: /schema:\s*["']brewva\.turn\.v1["']/u,
        message: "turn envelope schema must use TURN_ENVELOPE_SCHEMA",
      },
    ];

    for (const check of checks) {
      if (check.pattern.test(readRepoFile(check.path))) {
        offenders.push(`${check.path}: ${check.message}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("closed vocabulary arrays derive their public union types", () => {
    const delegation = readRepoFile("packages/brewva-vocabulary/src/internal/delegation.ts");

    expect(delegation).not.toMatch(/export\s+type\s+ReviewLaneName\s*=\s*string/u);
    expect(delegation).toMatch(
      /export\s+type\s+ReviewLaneName\s*=\s*\(?typeof\s+REVIEW_LANE_NAMES\)?\[number\]/u,
    );
  });

  test("runtime ops event aliases stay documented in vocabulary instead of naked consumer strings", () => {
    const publicEvents = readRepoFile("packages/brewva-vocabulary/src/events.ts");
    const internalEvents = readRepoFile("packages/brewva-vocabulary/src/internal/events.ts");

    expect(publicEvents).toContain("RUNTIME_OPS_EVENT_NAMESPACE");
    expect(publicEvents).toContain("RUNTIME_OPS_TO_TAPE_EVENT_TYPE");
    expect(internalEvents).toContain("reasoning_checkpoint_recorded");
    expect(internalEvents).toContain("session.compaction.committed");

    const offenders: string[] = [];
    const checks: readonly { path: string; pattern: RegExp; message: string }[] = [
      {
        path: "packages/brewva-tools/src/runtime-port/four-port/types.ts",
        pattern: /\["runtime\.ops"\]/u,
        message: "runtime ops namespace must come from vocabulary events",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/reasoning.ts",
        pattern: /"reasoning_(?:checkpoint|revert)_recorded"/u,
        message: "reasoning ops kinds must come from vocabulary events",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/session.ts",
        pattern: /"session\.compaction\.committed"/u,
        message: "session compaction ops kind must come from vocabulary events",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/tools.ts",
        pattern:
          /"tool\.(?:invocation\.(?:started|finished)|result\.recorded)"|"tool_call_observed"/u,
        message: "tool ops kinds must come from vocabulary events",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts",
        pattern: /"tool\.(?:invocation\.started|result\.recorded)"|"tool_call_observed"/u,
        message: "recall usage event types must reuse vocabulary ops constants",
      },
      {
        path: "packages/brewva-cli/src/operator/inspect/context-cockpit.ts",
        pattern: /"session\.compaction\.committed"/u,
        message: "CLI context cockpit must query the vocabulary-owned ops kind",
      },
      {
        path: "packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts",
        pattern: /"session\.compaction\.committed"/u,
        message: "context evidence must query the vocabulary-owned ops kind",
      },
      {
        path: "packages/brewva-session-index/src/projection/delegation.ts",
        pattern: /"tool_call_ended"/u,
        message: "session delegation projection must query the vocabulary-owned ops kind",
      },
    ];

    for (const check of checks) {
      if (check.pattern.test(readRepoFile(check.path))) {
        offenders.push(`${check.path}: ${check.message}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
