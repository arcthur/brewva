import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const packagesRoot = resolve(repoRoot, "packages");
const effectPackageRoot = resolve(packagesRoot, "brewva-effect");
const effectPackageName = "@brewva/brewva-effect";
const effectVersion = "4.0.0-beta.83";
const ownedEffectPackages = ["effect", "@effect/opentelemetry", "@effect/platform-node"] as const;
const effectPrimitiveAliases = [
  "BrewvaCause",
  "BrewvaConfig",
  "BrewvaContext",
  "BrewvaDeferred",
  "BrewvaDuration",
  "BrewvaEffect",
  "BrewvaExit",
  "BrewvaFiber",
  "BrewvaLayer",
  "BrewvaManagedRuntime",
  "BrewvaOption",
  "BrewvaPubSub",
  "BrewvaQueue",
  "BrewvaRef",
  "BrewvaSchedule",
  "BrewvaSchema",
  "BrewvaScope",
  "BrewvaStream",
] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectPackageJsonPaths(): string[] {
  return readdirSync(packagesRoot)
    .map((entry) => resolve(packagesRoot, entry, "package.json"))
    .filter((path) => existsSync(path))
    .toSorted();
}

function collectSourceFiles(relativePath: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  walk(resolve(repoRoot, relativePath));
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function dependencyVersions(manifest: Record<string, unknown>): Record<string, string> {
  const dependencies = manifest["dependencies"] as Record<string, string> | undefined;
  const devDependencies = manifest["devDependencies"] as Record<string, string> | undefined;
  return {
    ...dependencies,
    ...devDependencies,
  };
}

function packageNameForReport(manifest: Record<string, unknown>, packageJsonPath: string): string {
  const name = manifest["name"];
  return typeof name === "string" ? name : repoPath(packageJsonPath);
}

function splitImportSpecifiers(importBody: string): string[] {
  return importBody
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean);
}

function importedSpecifierName(specifier: string): string {
  return (
    specifier
      .replace(/^type\s+/u, "")
      .split(/\s+as\s+/u)[0]
      ?.trim() ?? ""
  );
}

describe("Effect runtime boundary fitness", () => {
  test("runtime package no longer ships a semantic Effect assembly layer", () => {
    const removedRuntimeEffectFiles = [
      "packages/brewva-runtime/src/runtime/effect-runtime-layer.ts",
      "packages/brewva-runtime/src/runtime/runtime-composition.ts",
      "packages/brewva-runtime/src/runtime-effect.ts",
    ];

    for (const file of removedRuntimeEffectFiles) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(false);
    }
  });

  test("brewva-effect owns exact Effect dependencies", () => {
    const manifest = readJson(resolve(effectPackageRoot, "package.json"));
    const dependencies = dependencyVersions(manifest);

    expect(manifest["name"]).toBe(effectPackageName);
    for (const packageName of ownedEffectPackages) {
      expect(dependencies[packageName]).toBe(effectVersion);
    }
  });

  test("workspace packages depend on brewva-effect instead of raw Effect platform packages", () => {
    const offenders: string[] = [];

    for (const packageJsonPath of collectPackageJsonPaths()) {
      const manifest = readJson(packageJsonPath);
      if (manifest["name"] === effectPackageName) continue;
      const dependencies = dependencyVersions(manifest);
      for (const packageName of ownedEffectPackages) {
        if (dependencies[packageName]) {
          offenders.push(`${packageNameForReport(manifest, packageJsonPath)} -> ${packageName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("brewva-effect root is Brewva boundary helpers, not a full Effect alias barrel", () => {
    const manifest = readJson(resolve(effectPackageRoot, "package.json"));
    const exportsMap = manifest["exports"] as Record<string, unknown>;
    const rootSource = readFileSync(resolve(effectPackageRoot, "src/index.ts"), "utf8");

    expect(existsSync(resolve(effectPackageRoot, "src/aliases.ts"))).toBe(false);
    expect(rootSource).not.toContain("./aliases.js");
    expect(rootSource).not.toContain("./primitives.js");
    expect(exportsMap["./primitives"]).toEqual({
      types: "./src/primitives.ts",
      bun: "./src/primitives.ts",
      import: "./dist/primitives.js",
      default: "./dist/primitives.js",
    });
  });

  test("Effect primitive aliases are imported only from the explicit primitives subpath", () => {
    const offenders: string[] = [];
    const primitiveSet = new Set<string>(effectPrimitiveAliases);
    const rootImportPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@brewva\/brewva-effect["'];/gu;

    for (const sourceFile of [
      ...collectSourceFiles("packages"),
      ...collectSourceFiles("test"),
      ...collectSourceFiles("script"),
    ]) {
      const source = readFileSync(sourceFile, "utf8");
      for (const match of source.matchAll(rootImportPattern)) {
        for (const specifier of splitImportSpecifiers(match[1] ?? "")) {
          const importedName = importedSpecifierName(specifier);
          if (primitiveSet.has(importedName)) {
            offenders.push(`${repoPath(sourceFile)} -> ${specifier}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("runtime service composition is ordinary TypeScript, not an Effect service bag", () => {
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-state.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime/effect-runtime-layer.ts")),
    ).toBe(false);
  });

  test("raw Effect imports stay isolated inside brewva-effect", () => {
    const offenders: string[] = [];

    for (const sourceFile of collectSourceFiles("packages")) {
      if (sourceFile.startsWith(`${effectPackageRoot}/`)) continue;
      const source = readFileSync(sourceFile, "utf8");
      if (/from\s+["'](?:effect|@effect\/[^"']+)["']/u.test(source)) {
        offenders.push(repoPath(sourceFile));
      }
    }

    expect(offenders).toEqual([]);
  });

  test("shared sleep helpers do not clone timer promises outside dedicated time modules", () => {
    const offenders: string[] = [];
    const sleepClonePattern =
      /export\s+(?:async\s+)?function\s+sleep\s*\([^)]*\)[\s\S]{0,300}new Promise[\s\S]{0,160}setTimeout/u;
    const dedicatedTimeModules = new Set([
      "packages/brewva-effect/src/schedules.ts",
      "packages/brewva-gateway/src/utils/async.ts",
    ]);

    for (const sourceFile of collectSourceFiles("packages")) {
      const path = repoPath(sourceFile);
      if (dedicatedTimeModules.has(path)) continue;
      const source = readFileSync(sourceFile, "utf8");
      if (sleepClonePattern.test(source)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("boundary schedule adapters close only the owning scope", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/brewva-effect/src/schedules.ts"),
      "utf8",
    );

    expect(source).toContain("makeScopedInterval");
    expect(source).toContain("makeScopedTimeout");
    expect(source).toContain("Scope.close(scope, Exit.succeed(undefined))");
    expect(source).not.toContain("resource.close");
  });

  test("direct runPromiseAtBoundary usage stays at declared runtime edges", () => {
    const allowed = new Set([
      "packages/brewva-effect/src/boundary.ts",
      "packages/brewva-effect/src/edge-runner.ts",
      "packages/brewva-effect/src/schedules.ts",
      "packages/brewva-effect/src/testing.ts",
    ]);
    const offenders: string[] = [];

    for (const sourceFile of collectSourceFiles("packages")) {
      const path = repoPath(sourceFile);
      const source = readFileSync(sourceFile, "utf8");
      if (!source.includes("runPromiseAtBoundary")) continue;
      if (!allowed.has(path)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("runBoundaryOperation stays in explicit adapter edges", () => {
    const allowed = new Set([
      "packages/brewva-effect/src/edge-runner.ts",
      "packages/brewva-gateway/src/channels/bridges/telegram/launcher.ts",
      "packages/brewva-gateway/src/daemon/gateway-daemon.ts",
      "packages/brewva-gateway/src/daemon/session-supervisor/index.ts",
      "packages/brewva-gateway/src/daemon/session-supervisor/worker-rpc.ts",
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts",
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-provider.ts",
      "packages/brewva-gateway/src/utils/async.ts",
      "packages/brewva-provider-core/src/stream/index.ts",
      "packages/brewva-substrate/src/host-api/plugin-runner.ts",
      "packages/brewva-substrate/src/host-api/plugin.ts",
    ]);
    const offenders: string[] = [];

    for (const sourceFile of collectSourceFiles("packages")) {
      const path = repoPath(sourceFile);
      const source = readFileSync(sourceFile, "utf8");
      if (!source.includes("runBoundaryOperation")) continue;
      if (!allowed.has(path)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("reusable effectful runtime operations keep Effect.fn identity", () => {
    const expectedOperations = [
      {
        file: "packages/brewva-tools/src/families/execution/exec/host-lane.ts",
        operation: 'BrewvaEffect.fn("tools.exec.host")',
      },
      {
        file: "packages/brewva-tools/src/families/execution/exec/box-lane.ts",
        operation: 'BrewvaEffect.fn("tools.exec.box")',
      },
    ];

    for (const { file, operation } of expectedOperations) {
      expect(readFileSync(resolve(repoRoot, file), "utf8")).toContain(operation);
    }
  });

  test("gateway serial queues are available as scoped Effect services", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/brewva-gateway/src/channels/effect-serial-queue.ts"),
      "utf8",
    );

    expect(source).toContain("class ChannelSerialQueueService extends BrewvaContext.Service");
    expect(source).toContain('BrewvaEffect.fn("gateway.channel.serialQueue.make")');
    expect(source).toContain("BrewvaLayer.effect(this, makeChannelSerialQueue(options))");
    expect(source).toContain("BrewvaEffect.addFinalizer");
    expect(source).toContain("createBrewvaServiceRuntime");
    expect(source).not.toContain("const pending = new Set<Promise");
  });

  test("managed exec process registry has a scoped Effect service boundary", () => {
    const source = readFileSync(
      resolve(
        repoRoot,
        "packages/brewva-tools/src/families/execution/exec-process-registry/service.ts",
      ),
      "utf8",
    );

    expect(source).toContain(
      "class ManagedExecProcessRegistryService extends BrewvaContext.Service",
    );
    expect(source).toContain('BrewvaEffect.fn("tools.exec.processRegistry.make")');
    expect(source).toContain("startHost");
    expect(source).toContain("startBox");
    expect(source).toContain("streamOutput");
    expect(source).toContain("BrewvaLayer.effect(this, makeManagedExecProcessRegistry())");
    expect(source).not.toContain("export function createManagedExecProcessRegistry");

    const runtimeSource = readFileSync(
      resolve(
        repoRoot,
        "packages/brewva-tools/src/families/execution/exec-process-registry/runtime.ts",
      ),
      "utf8",
    );
    expect(runtimeSource).toContain("createBrewvaServiceRuntime");
    expect(runtimeSource).not.toContain("runtimeFallbackRegistries");
    expect(runtimeSource).not.toContain("new WeakMap<object, ManagedExecProcessRegistryRuntime>");

    const apiSource = readFileSync(
      resolve(
        repoRoot,
        "packages/brewva-tools/src/families/execution/exec-process-registry/api.ts",
      ),
      "utf8",
    );
    expect(apiSource).not.toMatch(/\bcreateManagedExecProcessRegistry\b(?!Runtime)/u);
    expect(apiSource).not.toContain('export * from "./host.js"');
    expect(apiSource).not.toContain('export * from "./box.js"');
    expect(apiSource).not.toContain('export * from "./sessions.js"');
  });
});
