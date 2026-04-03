import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("JSONC config surface guard", () => {
  it("keeps human-authored runtime and gateway config entrypoints on parseJsonc", () => {
    const runtimeConfigLoader = readRepoFile("packages/brewva-runtime/src/config/loader.ts");
    const subagentConfigLoader = readRepoFile(
      "packages/brewva-gateway/src/subagents/config-files.ts",
    );
    const agentRuntimeManager = readRepoFile(
      "packages/brewva-gateway/src/channels/agent-runtime-manager.ts",
    );
    const heartbeatPolicy = readRepoFile("packages/brewva-gateway/src/daemon/heartbeat-policy.ts");

    expect(runtimeConfigLoader).toContain("parseJsonc(raw)");
    expect(runtimeConfigLoader).not.toContain("JSON.parse(raw)");

    expect(subagentConfigLoader).toContain("parseJsonc(raw)");
    expect(subagentConfigLoader).not.toContain("JSON.parse(raw)");

    expect(agentRuntimeManager).toContain("parseJsonc(raw)");
    expect(agentRuntimeManager).not.toContain("JSON.parse(raw)");

    expect(heartbeatPolicy).toContain("parseJsonc(block)");
    expect(heartbeatPolicy).not.toContain("JSON.parse(block)");
  });
});
