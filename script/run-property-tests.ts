#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TEST_ROOTS = ["test/unit", "test/contract"] as const;
const PROPERTY_TEST_SUFFIXES = [".property.test.ts", ".property.contract.test.ts"] as const;

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (PROPERTY_TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      files.push(relative(ROOT, path));
    }
  }
  return files;
}

const files = TEST_ROOTS.flatMap((root) => walk(join(ROOT, root))).toSorted();

if (files.length === 0) {
  console.error("No property test files found.");
  process.exit(1);
}

console.log(`Running ${files.length} property test files.`);

const result = spawnSync("bun", ["test", ...files, "--timeout", "600000"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`Failed to start bun test: ${result.error.message}`);
  process.exit(1);
}

if (result.signal !== null) {
  console.error(`bun test terminated by signal ${result.signal}`);
  process.exit(signalExitCode(result.signal));
}

process.exit(result.status ?? 1);

function signalExitCode(signal: string): number {
  const signalNumber = osConstants.signals[signal as keyof typeof osConstants.signals];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}
