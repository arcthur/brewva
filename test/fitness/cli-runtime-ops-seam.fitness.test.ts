import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

// The gateway `ops` facade (authority/operator/inspect) is reached from the CLI
// only through its port layer: the typed `runtime/runtime-ports.ts` facade and
// the `shell/ports/*` adapters. Every other CLI module consumes those narrow
// functions instead of dereferencing `runtime.ops` directly, so the wide gateway
// facade stays effectively gateway-private at the CLI boundary (WS3).
const allowedOpsSeamOwners = [
  /^packages\/brewva-cli\/src\/runtime\/runtime-ports\.ts$/u,
  /^packages\/brewva-cli\/src\/shell\/ports\//u,
] as const;

const runtimeOpsAccess = /runtime\.ops\b/u;

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
  test("keeps runtime.ops dereferences inside the CLI port layer", () => {
    const offenders = listTypeScriptFiles("packages/brewva-cli/src")
      .filter((file) => !isAllowed(file, allowedOpsSeamOwners))
      .filter((file) => runtimeOpsAccess.test(readFileSync(resolve(repoRoot, file), "utf-8")))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
