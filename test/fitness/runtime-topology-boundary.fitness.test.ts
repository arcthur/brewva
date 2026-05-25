import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function lineCount(source: string): number {
  return source.split("\n").length;
}

describe("runtime topology boundary fitness", () => {
  test("retired hosted turn port binding does not reappear in production code", () => {
    const runtimePorts = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts",
    );
    const runtimeTurn = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-turn-runtime.ts",
    );

    expect(runtimePorts).not.toContain("bindTurnPorts");
    expect(runtimePorts).not.toContain("as unknown as RuntimeAdapterOpsPort");
    expect(runtimePorts).not.toContain("as unknown as HostedRuntimeAdapterPort");
    expect(runtimeTurn).not.toContain("bindTurnPorts");
    expect(runtimeTurn).toContain("createRuntime?.({ physics })");
  });

  test("keeps provider driver mechanics out of the runtime turn implementation", () => {
    const runtimeTurn = readRepoFile("packages/brewva-runtime/src/runtime/turn/impl.ts");

    expect(runtimeTurn).not.toMatch(/getApiKeyAndHeaders|modelRegistry|modelCatalog/u);
    expect(runtimeTurn).not.toMatch(/ProviderConnection|authorizeOAuth|completeOAuth/u);
    expect(runtimeTurn).not.toMatch(/cacheFingerprint|render.*Cache|providerCache/u);
  });

  test("keeps envelope translation free of runtime physics decisions", () => {
    const turnEnvelope = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts",
    );

    expect(turnEnvelope).not.toMatch(/provider_retry|terminal_commit/u);
    expect(turnEnvelope).not.toMatch(/provider_tool_continuation_limit|commitToolResult/u);
    expect(turnEnvelope).not.toContain("beginToolCall");
  });

  test("keeps hosted runtime execution ports as an ownership barrel", () => {
    const executionPorts = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts",
    );
    const runtimeAssembly = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");

    expect(lineCount(executionPorts)).toBeLessThanOrEqual(40);
    expect(executionPorts).not.toMatch(/providerRuntimeLayer|streamProviderMessage/u);
    expect(executionPorts).not.toMatch(/createActionPolicyRegistry|resolveToolAuthority/u);
    expect(lineCount(runtimeAssembly)).toBeLessThanOrEqual(260);
    expect(runtimeAssembly).toContain("createRuntimePhysicsTurnRunner");
    expect(runtimeAssembly).not.toContain("function createReplayThenRealTurnRunner");
  });

  test("keeps live session mux logic in the session-mux adapter", () => {
    const adapter = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts",
    );
    const sessionMuxPath =
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/session-mux/runtime-frame-projection.ts";
    const sessionMux = readRepoFile(sessionMuxPath);

    expect(
      existsSync(
        join(REPO_ROOT, "packages/brewva-gateway/src/hosted/internal/turn-adapter/session-mux"),
      ),
    ).toBe(true);
    expect(adapter).toContain('from "./session-mux/runtime-frame-projection.js"');
    expect(adapter).not.toContain("SESSION_WIRE_SCHEMA");
    expect(adapter).not.toContain("runtimeToolCallFromEventPayload");
    expect(sessionMux).toContain("export function emitRuntimeEventFrame");
    expect(sessionMux).toContain("export function emitRuntimeToolProgressFrame");
    expect(lineCount(adapter)).toBeLessThanOrEqual(360);
    expect(lineCount(sessionMux)).toBeLessThanOrEqual(500);
  });

  test("keeps provider binding adapter below the topology fold soft ceiling", () => {
    const providerAdapter = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-provider.ts",
    );

    expect(lineCount(providerAdapter)).toBeLessThanOrEqual(900);
  });
});
