import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

const allowedBrewvaRuntimeInstanceOwners = [
  /^packages\/brewva-runtime\/src\/(?:public|runtime)\//u,
  /^packages\/brewva-gateway\/src\/hosted\/internal\/session\//u,
  /^packages\/brewva-gateway\/src\/delegation\/background\/controller\.ts$/u,
  /^test\/helpers\/runtime-internals\.ts$/u,
  /^test\/fitness\/runtime-instance-imports\.fitness\.test\.ts$/u,
] as const;

const allowedCreateBrewvaRuntimeOwners = [
  /^packages\/brewva-cli\/src\/entry\/main\.ts$/u,
  /^packages\/brewva-cli\/src\/commands\/noninteractive\/daemon\.ts$/u,
  /^packages\/brewva-cli\/src\/operator\/insights\.ts$/u,
  /^packages\/brewva-cli\/src\/operator\/inspect\/cli\.ts$/u,
  /^packages\/brewva-gateway\/src\/channels\/(?:agent-runtime-manager|wiring)\.ts$/u,
  /^packages\/brewva-gateway\/src\/daemon\/gateway-daemon\.ts$/u,
  /^packages\/brewva-gateway\/src\/delegation\/background\/runner-main\.ts$/u,
  /^packages\/brewva-gateway\/src\/hosted\/internal\/session\//u,
  /^script\/(?:report-context-evidence|verify-dist)\.ts$/u,
] as const;

function isAllowed(file: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(file));
}

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
      .filter((file) => !isAllowed(file, allowedBrewvaRuntimeInstanceOwners))
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
      .filter((file) => !isAllowed(file, allowedCreateBrewvaRuntimeOwners))
      .filter((file) =>
        /import\s+\{[^}]*\bcreateBrewvaRuntime\b[^}]*\}\s+from\s+"@brewva\/brewva-runtime";/su.test(
          readFileSync(resolve(repoRoot, file), "utf-8"),
        ),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
