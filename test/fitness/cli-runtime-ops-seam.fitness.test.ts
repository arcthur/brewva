import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

// The gateway `ops` facade (authority/operator/inspect) is reached from the CLI
// only through the single capability-port factory `runtime/cli-runtime-ports.ts`,
// which assembles the narrow `inspect`/`operator` ports once at the composition
// boundary. Every other CLI module consumes those capability-scoped ports instead
// of dereferencing `.ops` directly, so the wide gateway facade stays effectively
// gateway-private at the CLI boundary (WS3 "retire the wide adapter").
const allowedOpsSeamOwners = [
  /^packages\/brewva-cli\/src\/runtime\/cli-runtime-ports\.ts$/u,
] as const;

const opsAccess = /\.ops\b/u;

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

describe("cli runtime ops seam", () => {
  test("reaches the gateway ops facade only through the capability-port factory", () => {
    const offenders = listTypeScriptFiles("packages/brewva-cli/src")
      .filter((file) => !isAllowed(file, allowedOpsSeamOwners))
      .filter((file) => opsAccess.test(readFileSync(resolve(repoRoot, file), "utf-8")))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
