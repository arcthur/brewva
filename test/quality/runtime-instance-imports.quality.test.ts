import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

const allowedBrewvaRuntimeInstanceUsers = new Set([
  "packages/brewva-runtime/src/public/index.ts",
  "packages/brewva-runtime/src/runtime/runtime-api.ts",
  "packages/brewva-runtime/src/runtime/runtime.ts",
  "packages/brewva-gateway/src/delegation/background/controller.ts",
  "packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts",
  "packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts",
  "packages/brewva-gateway/src/hosted/internal/session/local-session-services.ts",
  "packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts",
  "test/helpers/runtime-internals.ts",
  "test/quality/runtime-instance-imports.quality.test.ts",
]);

const allowedCreateBrewvaRuntimeUsers = new Set([
  "packages/brewva-cli/src/daemon-mode.ts",
  "packages/brewva-cli/src/index.ts",
  "packages/brewva-cli/src/inspect.ts",
  "packages/brewva-cli/src/insights.ts",
  "packages/brewva-gateway/src/channels/agent-runtime-manager.ts",
  "packages/brewva-gateway/src/channels/wiring.ts",
  "packages/brewva-gateway/src/daemon/gateway-daemon.ts",
  "packages/brewva-gateway/src/delegation/background/runner-main.ts",
  "packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts",
  "packages/brewva-gateway/src/hosted/internal/session/init/environment.ts",
  "packages/brewva-gateway/src/hosted/internal/session/local-session-services.ts",
  "script/report-context-evidence.ts",
  "script/verify-dist.ts",
]);

function listTypeScriptFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const absolutePath = resolve(absoluteDir, entry);
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(relativePath));
      continue;
    }
    if (stats.isFile() && relativePath.endsWith(".ts")) {
      files.push(relativePath);
    }
  }

  return files;
}

describe("runtime instance import boundary", () => {
  test("keeps BrewvaRuntimeInstance in composition and test-internal owners only", () => {
    const offenders = [
      ...listTypeScriptFiles("packages"),
      ...listTypeScriptFiles("test"),
      ...listTypeScriptFiles("script"),
    ]
      .filter((file) => !allowedBrewvaRuntimeInstanceUsers.has(file))
      .filter((file) =>
        /import\s+(?:type\s+)?\{[^}]*\bBrewvaRuntimeInstance\b[^}]*\}\s+from\s+"@brewva\/brewva-runtime";/su.test(
          readFileSync(resolve(repoRoot, file), "utf-8"),
        ),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("keeps createBrewvaRuntime in production composition roots only", () => {
    const offenders = [...listTypeScriptFiles("packages"), ...listTypeScriptFiles("script")]
      .filter((file) => !allowedCreateBrewvaRuntimeUsers.has(file))
      .filter((file) =>
        /import\s+\{[^}]*\bcreateBrewvaRuntime\b[^}]*\}\s+from\s+"@brewva\/brewva-runtime";/su.test(
          readFileSync(resolve(repoRoot, file), "utf-8"),
        ),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
