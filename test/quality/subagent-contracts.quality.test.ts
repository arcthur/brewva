import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("subagent contract guard", () => {
  it("keeps detached subagent durable specs on v7 only", () => {
    const readerSource = readRepoFile("packages/brewva-gateway/src/subagents/runner-main.ts");
    const protocolSource = readRepoFile(
      "packages/brewva-gateway/src/subagents/background-protocol.ts",
    );

    expect(readerSource).toContain("brewva.subagent-run-spec.v7");
    expect(readerSource).not.toContain("brewva.subagent-run-spec.v6");
    expect(protocolSource).toContain('schema: "brewva.subagent-run-spec.v7"');
  });

  it("keeps markdown worker overlays scoped to the supported project roots", () => {
    const loaderSource = readRepoFile("packages/brewva-gateway/src/subagents/config-files.ts");

    expect(loaderSource).toContain('resolve(workspaceRoot, ".brewva", "agents")');
    expect(loaderSource).toContain('resolve(workspaceRoot, ".config", "brewva", "agents")');
  });
});
