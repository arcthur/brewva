import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
      resolve(repoRoot, "packages", "brewva-agent-engine"),
      resolve(repoRoot, "packages", "brewva-provider-core"),
      resolve(repoRoot, "packages", "brewva-substrate"),
      resolve(repoRoot, "packages", "brewva-tools"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "runtime-plugins"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "session", "contracts.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "session", "collect-output.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "tool-execution-traits.ts"),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "channels",
        "channel-agent-dispatch.ts",
      ),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "session", "compaction-recovery.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "host", "hosted-session-bootstrap.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "host", "hosted-provider-driver.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "host", "semantic-reranker.ts"),
      resolve(repoRoot, "packages", "brewva-gateway", "src", "subagents", "model-routing.ts"),
      resolve(repoRoot, "packages", "brewva-cli", "src", "inspect-command-runtime-plugin.ts"),
      resolve(repoRoot, "packages", "brewva-cli", "src", "insights-command-runtime-plugin.ts"),
      resolve(repoRoot, "packages", "brewva-cli", "src", "questions-command-runtime-plugin.ts"),
      resolve(
        repoRoot,
        "packages",
        "brewva-cli",
        "src",
        "agent-overlays-command-runtime-plugin.ts",
      ),
      resolve(repoRoot, "packages", "brewva-cli", "src", "update-command-runtime-plugin.ts"),
      resolve(
        repoRoot,
        "packages",
        "brewva-gateway",
        "src",
        "channels",
        "channel-a2a-runtime-plugin.ts",
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
