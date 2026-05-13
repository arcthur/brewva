import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runtime entrypoint surface", () => {
  test("keeps projection internals out of runtime root surface while exposing dedicated subpaths", async () => {
    const runtime = await import("@brewva/brewva-runtime");
    const events = await import("@brewva/brewva-runtime/events");
    const evidence = await import("@brewva/brewva-runtime/evidence");
    const semanticArtifacts = await import("@brewva/brewva-runtime/semantic-artifacts");

    expect("ProjectionEngine" in runtime).toBe(false);
    expect("ProjectionStore" in runtime).toBe(false);
    expect("buildWorkingProjectionSnapshot" in runtime).toBe(false);
    expect("extractProjectionFromEvent" in runtime).toBe(false);
    expect("getSemanticArtifactSchema" in runtime).toBe(false);
    expect("getSemanticArtifactOutputContract" in runtime).toBe(false);
    expect("deriveSemanticBindingOutputContracts" in runtime).toBe(false);
    expect("renderSemanticArtifactExample" in runtime).toBe(false);
    expect("SKILL_COMPLETED_EVENT_TYPE" in runtime).toBe(false);
    expect("BREWVA_REGISTERED_EVENT_TYPES" in runtime).toBe(false);
    expect("readSkillCompletedEventPayload" in runtime).toBe(false);
    expect("asBrewvaEventType" in runtime).toBe(false);

    expect("SKILL_COMPLETED_EVENT_TYPE" in events).toBe(false);
    expect("BREWVA_REGISTERED_EVENT_TYPES" in events).toBe(true);
    expect("readSkillCompletedEventPayload" in events).toBe(false);
    expect("asBrewvaEventType" in events).toBe(true);
    expect("parseTscDiagnostics" in runtime).toBe(false);
    expect("parseTscDiagnostics" in evidence).toBe(true);
    expect("getSemanticArtifactOutputContract" in semanticArtifacts).toBe(true);
    expect("renderSemanticArtifactExample" in semanticArtifacts).toBe(true);
  });

  test("dedicated subpath extension ports expose only public methods", async () => {
    const runtime = await import("@brewva/brewva-runtime");
    const context = await import("@brewva/brewva-runtime/context");
    const credentials = await import("@brewva/brewva-runtime/credentials");
    const parallel = await import("@brewva/brewva-runtime/parallel");
    const recovery = await import("@brewva/brewva-runtime/recovery");

    expect("createContextArena" in context).toBe(false);
    const contextBudget = context.createContextBudgetManager(
      runtime.DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    );
    expect(Object.isSealed(contextBudget)).toBe(true);
    expect(Object.keys(contextBudget)).not.toContain("sessionState");

    const vault = credentials.createCredentialVaultService({
      vaultPath: join(mkdtempSync(join(tmpdir(), "brewva-vault-")), "credentials.json"),
      env: {},
    });
    expect(Object.isSealed(vault)).toBe(true);
    expect(Object.keys(vault)).not.toContain("vaultPath");
    expect(Object.keys(vault)).not.toContain("env");
    expect(Object.keys(vault)).not.toContain("resolveKey");
    expect(Object.keys(vault)).not.toContain("encrypt");
    expect(Object.keys(vault)).not.toContain("decrypt");
    expect(Object.keys(vault)).not.toContain("load");
    expect(Object.keys(vault)).not.toContain("save");

    const budget = parallel.createParallelBudgetManager({
      enabled: true,
      maxConcurrent: 2,
      maxTotalPerSession: 4,
    });
    expect(Object.isSealed(budget)).toBe(true);
    expect(Object.keys(budget)).not.toContain("config");
    expect(Object.keys(budget)).not.toContain("sessions");
    expect(Object.keys(budget)).not.toContain("getOrCreate");
    expect(Object.keys(budget)).not.toContain("drainWaiters");

    const walStore = recovery.createRecoveryWalStore({
      workspaceRoot: mkdtempSync(join(tmpdir(), "brewva-wal-")),
      config: (await import("@brewva/brewva-runtime")).DEFAULT_BREWVA_CONFIG.infrastructure
        .recoveryWal,
      scope: "runtime",
    });
    expect(Object.isSealed(walStore)).toBe(true);
    expect(Object.keys(walStore)).not.toContain("workspaceRoot");
    expect(Object.keys(walStore)).not.toContain("scope");
    expect(Object.keys(walStore)).not.toContain("filePath");
    expect(Object.keys(walStore)).not.toContain("config");
    expect(Object.keys(walStore)).not.toContain("enabled");
  });

  test("runtime event append validates typed descriptor payloads", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");
    const events = await import("@brewva/brewva-runtime/events");
    const cwd = mkdtempSync(join(tmpdir(), "brewva-runtime-"));
    const config = structuredClone(runtimeModule.DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events = {
      enabled: true,
      level: "debug",
      dir: ".brewva/events",
    };
    const runtime = runtimeModule.createBrewvaRuntime({
      cwd,
      config,
    });

    expect(() =>
      runtime.hosted.extensions.hosted.events.record({
        sessionId: "review",
        type: events.VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        payload: { bad: true },
      }),
    ).toThrow("invalid_recorded_event_payload:verification_outcome_recorded");
  });

  test("runtime factory returns frozen explicit ports without legacy root reflection", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");
    const runtime = runtimeModule.createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-factory-")),
    });

    expect("BrewvaRuntime" in runtimeModule).toBe(false);
    expect("createHostedRuntimePort" in runtimeModule).toBe(false);
    expect("createToolRuntimePort" in runtimeModule).toBe(false);
    expect("createOperatorRuntimePort" in runtimeModule).toBe(false);
    expect(Object.keys(runtime)).toEqual(["root", "hosted", "tool", "operator"]);
    expect(Object.keys(runtime.root)).toEqual(["identity", "config", "authority", "inspect"]);
    expect(Object.getOwnPropertySymbols(runtime.root)).toEqual([]);
    expect("operator" in runtime.root).toBe(false);
    expect("extensions" in runtime.root).toBe(false);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.root)).toBe(true);
    expect(Object.isFrozen(runtime.hosted)).toBe(true);
    expect(Object.isFrozen(runtime.tool)).toBe(true);
    expect(Object.isFrozen(runtime.operator)).toBe(true);
    expect(Object.isFrozen(runtime.hosted.extensions)).toBe(true);
    expect(Object.isFrozen(runtime.tool.extensions)).toBe(true);
    expect(runtimeModule.selectOperatorRuntimePort(runtime)).toBe(runtime.operator);
  });
});
