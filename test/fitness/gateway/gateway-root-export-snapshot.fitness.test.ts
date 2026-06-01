import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./shared.js";

const expectedExportKeys = [
  ".",
  "./hosted",
  "./channels",
  "./daemon",
  "./admin",
  "./ingress",
  "./extensions",
  "./harness",
  "./delegation",
  "./policy/model-routing",
  "./protocol",
] as const;

describe("gateway root exports", () => {
  test("matches the narrowed package export map", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-gateway/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports)).toEqual([...expectedExportKeys]);
  });

  test("keeps the root barrel named-only", () => {
    const source = readRepoFile("packages/brewva-gateway/src/index.ts");
    expect(source).not.toContain("export * from");
    expect(source).not.toContain("./conversations/");
    expect(source).not.toContain("AgentRegistry");
    expect(source).not.toContain("AgentRuntimeManager");
    expect(source).not.toContain("ChannelCoordinator");
    expect(source).not.toContain("CommandRouter");
    expect(source).not.toContain("collectPromptTurnOutputs");
    expect(source).not.toContain("buildChannelDispatchPrompt");
    expect(source).not.toContain("runChannelModeOperation");
  });
});
