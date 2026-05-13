import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, gatewayRelative, readRepoFile } from "./shared.js";

describe("host init pipeline boundary", () => {
  test("pins explicit init modules for environment, orchestration, and mcp lifecycle", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("hosted", "internal", "session", "init", "environment.ts"),
        gatewayRelative("hosted", "internal", "session", "init", "orchestration.ts"),
        gatewayRelative("hosted", "internal", "session", "init", "mcp-lifecycle.ts"),
        gatewayRelative("hosted", "internal", "session", "init", "session-assembly.ts"),
      ]),
    ).toEqual([]);
  });

  test("keeps session assembly direct and free of bootstrap shims", () => {
    const canonical = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts",
    );
    expect(canonical).toContain('from "./environment.js"');
    expect(canonical).toContain('from "./orchestration.js"');
    expect(canonical).toContain('from "./mcp-lifecycle.js"');
    expect(canonical).not.toContain("function createKernelRuntime(");
    expect(canonical).not.toContain("function createHostedOrchestration(");
    expect(canonical).not.toContain("function createHostedMcpEventRecorder(");
  });
});
