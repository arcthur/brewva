import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./shared.js";

const expectedKinds = [
  "init",
  "provider-bound",
  "tool-bound",
  "ready",
  "turn-active",
  "recovering",
  "closing",
  "closed",
] as const;

describe("hosted session phase union", () => {
  test("defines the required hosted-session lifecycle kinds", () => {
    const source = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/session-phase/api.ts",
    );
    for (const kind of expectedKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
  });

  test("is consumed by host bootstrap and lifecycle seams", () => {
    const bootstrap = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts",
    );
    const lifecycle = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/init/session-lifecycle.ts",
    );
    expect(bootstrap).toContain('from "../session-phase/api.js"');
    expect(bootstrap).toContain("phase: HostedSessionPhase");
    expect(bootstrap).toContain("initPhases: readonly HostedSessionPhase[]");
    expect(bootstrap).toContain("createHostedSessionInitPhases");
    expect(lifecycle).toContain("projectHostedRuntimePhase");
  });
});
