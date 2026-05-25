import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("runtime physics boundary fitness", () => {
  test("keeps runtime construction behind one explicit physics declaration", () => {
    const api = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const optionsBody = api.match(/export interface BrewvaRuntimeOptions \{(?<body>[\s\S]*?)\n\}/u)
      ?.groups?.["body"];

    expect(optionsBody).toContain("physics: RuntimePhysicsDeclaration");
    expect(optionsBody).not.toMatch(/\\bprovider\\??:/u);
    expect(optionsBody).not.toMatch(/\\btoolExecutor\\??:/u);
    expect(optionsBody).not.toMatch(/\\bresolveToolAuthority\\??:/u);
  });

  test("requires real physics to declare the world execution ports", () => {
    const api = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const physics = readRepoFile("packages/brewva-runtime/src/runtime/turn/physics.ts");

    expect(api).toContain('readonly mode: "real";');
    expect(api).toContain("readonly provider: RuntimeProviderPort;");
    expect(api).toContain("readonly toolExecutor: RuntimeToolExecutorPort;");
    expect(api).not.toContain("readonly toolExecutor?: RuntimeToolExecutorPort;");
    expect(physics).toContain("runtime_physics_real_requires_provider");
    expect(physics).toContain("runtime_physics_real_requires_tool_executor");
    expect(physics).toContain("runtime_physics_replay_then_real_requires_tool_executor");
  });

  test("does not hide a fallback provider inside the turn runner", () => {
    const turnRunner = readRepoFile("packages/brewva-runtime/src/runtime/turn/impl.ts");

    expect(turnRunner).not.toContain("EMPTY_PROVIDER");
    expect(turnRunner).toContain("provider: RuntimeProviderPort");
    expect(turnRunner).not.toContain("provider?: RuntimeProviderPort");
  });

  test("keeps replay modes read-only and fork-targeted in runtime assembly", () => {
    const physics = readRepoFile("packages/brewva-runtime/src/runtime/turn/physics.ts");

    expect(physics).toContain("runtime_physics_replay_is_read_only");
    expect(physics).toContain("runtime_physics_replay_target_must_fork_session");
    expect(physics).toContain("createReplayThenRealTurnRunner");
    expect(physics).toContain("createDisabledTapeCommitPort");
  });
});
