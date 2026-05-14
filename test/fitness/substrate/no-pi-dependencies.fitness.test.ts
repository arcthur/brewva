import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PI_IMPORT_PATTERN = /@mariozechner\/pi-/u;

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".json")) {
      files.push(path);
    }
  }

  return files;
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const stat = statSync(root);
  if (stat.isDirectory()) {
    return walk(root);
  }
  return root.endsWith(".ts") || root.endsWith(".json") ? [root] : [];
}

describe("substrate dependency boundary", () => {
  test("keeps substrate-owned host and tool surfaces free of direct Pi dependencies", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const roots = [
      resolve(repoRoot, "packages", "brewva-provider-core"),
      resolve(repoRoot, "packages", "brewva-substrate"),
      resolve(repoRoot, "packages", "brewva-substrate", "src", "turn"),
      resolve(repoRoot, "packages", "brewva-tools"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "extensions"),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "thread-loop",
        "contracts.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "thread-loop",
        "collect-output.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "session",
        "internal",
        "tool-execution-traits.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "channels",
        "channel-agent-dispatch.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "thread-loop",
        "compaction-recovery.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "session",
        "init",
        "session-assembly.ts",
      ),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "hosted",
        "internal",
        "session",
        "provider",
        "completion-client.ts",
      ),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "delegation", "model-routing.ts"),
      resolve(repoRoot, "packages", "brewva-cli", "src", "commands", "extensions"),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "channels",
        "bridges",
        "a2a",
        "extension.ts",
      ),
    ];

    const violations: string[] = [];
    for (const root of roots) {
      for (const file of collectFiles(root)) {
        const content = readFileSync(file, "utf8");
        if (!PI_IMPORT_PATTERN.test(content)) {
          continue;
        }
        violations.push(relative(repoRoot, file));
      }
    }

    expect(
      violations,
      `Found Pi dependencies in substrate-aligned packages:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
