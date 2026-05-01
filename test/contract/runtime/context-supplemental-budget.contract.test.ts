import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

function appendGuardedSupplemental(
  runtime: BrewvaRuntime,
  sessionId: string,
  content: string,
  usage:
    | {
        tokens: number;
        contextWindow: number;
        percent: number;
      }
    | undefined,
  injectionScopeId?: string,
) {
  return runtime.maintain.context.appendGuardedSupplementalBlocks(
    sessionId,
    [
      {
        familyId: "test-guarded-supplemental",
        content,
      },
    ],
    usage,
    injectionScopeId,
  )[0]!;
}

describe("context supplemental budget", () => {
  test("disables primary and supplemental token caps when contextBudget.enabled=false", async () => {
    const workspace = createWorkspace("context-budget-disabled");
    const config = createConfig({});
    config.infrastructure.contextBudget.enabled = false;
    setStaticContextInjectionBudget(config, 32);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "context-budget-disabled-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.authority.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        channelSuccess: true,
      });
    }

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const primary = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix flaky test and keep complete context",
      {
        tokens: 900,
        contextWindow: 2000,
        percent: 0.45,
      },
      { injectionScopeId: "leaf-a" },
    );
    expect(primary.accepted).toBe(true);
    expect(primary.finalTokens).toBeGreaterThan(0);

    const supplemental = appendGuardedSupplemental(
      runtime,
      sessionId,
      "y".repeat(800),
      {
        tokens: 920,
        contextWindow: 2000,
        percent: 0.46,
      },
      "leaf-a",
    );
    expect(supplemental.accepted).toBe(true);
    expect(supplemental.droppedReason).toBeUndefined();
    expect(supplemental.finalTokens).toBeGreaterThan(0);
  });

  test("coordinates supplemental injection budget with primary context injection per scope", async () => {
    const workspace = createWorkspace("context-supplemental-budget");
    const config = createConfig({});
    setStaticContextInjectionBudget(config, 48);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "context-supplemental-budget-1";
    const usage = {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    };

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const primary = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix flaky tests",
      usage,
      { injectionScopeId: "leaf-a" },
    );
    const supplemental = appendGuardedSupplemental(
      runtime,
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    const primaryTokens = primary.accepted ? primary.finalTokens : 0;
    const supplementalTokens = supplemental.accepted ? supplemental.finalTokens : 0;
    expect(primaryTokens + supplementalTokens).toBeLessThanOrEqual(48);
    if (!supplemental.accepted) {
      expect(supplemental.droppedReason).toBe("budget_exhausted");
    }

    const otherScope = appendGuardedSupplemental(
      runtime,
      sessionId,
      "y".repeat(120),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.maintain.context.onTurnStart(sessionId, 2);
    const afterTurnReset = appendGuardedSupplemental(
      runtime,
      sessionId,
      "z".repeat(120),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("reserves supplemental budget immediately after append", async () => {
    const workspace = createWorkspace("context-supplemental-commit");
    const config = createConfig({});
    setStaticContextInjectionBudget(config, 24);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "context-supplemental-commit-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const first = appendGuardedSupplemental(runtime, sessionId, "x".repeat(2000), usage, "leaf-a");
    expect(first.accepted).toBe(true);

    const second = appendGuardedSupplemental(runtime, sessionId, "x".repeat(2000), usage, "leaf-a");
    expect(second.accepted).toBe(false);
    expect(second.droppedReason).toBe("budget_exhausted");

    const exhausted = appendGuardedSupplemental(
      runtime,
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(exhausted.accepted).toBe(false);
    expect(exhausted.droppedReason).toBe("budget_exhausted");

    const otherScope = appendGuardedSupplemental(
      runtime,
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.maintain.context.onTurnStart(sessionId, 2);
    const afterTurnReset = appendGuardedSupplemental(
      runtime,
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("keeps supplemental reservation when duplicate primary injection clears only primary tokens", async () => {
    const workspace = createWorkspace("context-supplemental-duplicate-primary");
    const config = createConfig({});
    setStaticContextInjectionBudget(config, 128);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "context-supplemental-duplicate-primary-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Preserve supplemental reservation after duplicate primary injection.",
    });

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const primary = await runtime.maintain.context.buildInjection(
      sessionId,
      "stabilize duplicate scope budget",
      usage,
      { injectionScopeId: "leaf-a" },
    );
    expect(primary.accepted).toBe(true);

    const firstSupplemental = appendGuardedSupplemental(
      runtime,
      sessionId,
      "s".repeat(28),
      usage,
      "leaf-a",
    );
    expect(firstSupplemental.accepted).toBe(true);
    expect(firstSupplemental.finalTokens).toBeGreaterThan(0);

    const duplicatePrimary = await runtime.maintain.context.buildInjection(
      sessionId,
      "stabilize duplicate scope budget",
      usage,
      { injectionScopeId: "leaf-a" },
    );
    expect(duplicatePrimary.accepted).toBe(false);

    const secondSupplemental = appendGuardedSupplemental(
      runtime,
      sessionId,
      "z".repeat(4000),
      usage,
      "leaf-a",
    );
    expect(secondSupplemental.accepted).toBe(true);
    expect(secondSupplemental.finalTokens).toBeLessThanOrEqual(128 - firstSupplemental.finalTokens);
  });
});
