import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: context budget", () => {
  test("drops context injection when usage exceeds hard limit", async () => {
    const workspace = createWorkspace("context-budget");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });

    const decision = await runtime.context.buildInjection("ctx-1", "fix broken test in runtime", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(decision.accepted).toBe(false);
  });

  test("deduplicates per branch scope and allows reinjection after compaction", async () => {
    const workspace = createWorkspace("context-injection-dedup");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const sessionId = "context-injection-dedup-1";
    runtime.ledger.getDigest = () => "[Ledger Digest]\nrecords=0 pass=0 fail=0 inconclusive=0";

    runtime.context.onTurnStart(sessionId, 1);
    const first = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 600,
        contextWindow: 4000,
        percent: 0.15,
      },
      "leaf-a",
    );
    expect(first.accepted).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);

    runtime.context.onTurnStart(sessionId, 2);
    const second = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 610,
        contextWindow: 4000,
        percent: 0.16,
      },
      "leaf-a",
    );
    expect(second.accepted).toBe(false);

    runtime.context.onTurnStart(sessionId, 3);
    const third = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 620,
        contextWindow: 4000,
        percent: 0.17,
      },
      "leaf-b",
    );
    expect(third.accepted).toBe(true);
    expect(third.text.length).toBeGreaterThan(0);

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1500,
      toTokens: 500,
    });
    runtime.context.onTurnStart(sessionId, 4);

    const fourth = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 630,
        contextWindow: 4000,
        percent: 0.18,
      },
      "leaf-a",
    );
    expect(fourth.accepted).toBe(true);
    expect(fourth.text.length).toBeGreaterThan(0);
  });

  test("truncates context injection to the configured effective injection budget", async () => {
    const workspace = createWorkspace("context-injection-truncate");
    const config = createConfig({});
    setStaticContextInjectionBudget(config, 32);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-injection-truncate-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        channelSuccess: true,
      });
    }

    const injection = await runtime.context.buildInjection(sessionId, "fix bug", {
      tokens: 1000,
      contextWindow: 2000,
      percent: 0.5,
    });
    expect(injection.accepted).toBe(true);
    expect(injection.finalTokens).toBeLessThanOrEqual(32);
    expect(injection.text.length).toBeGreaterThan(0);
  });

  test("disables primary and supplemental token caps when contextBudget.enabled=false", async () => {
    const workspace = createWorkspace("context-budget-disabled");
    const config = createConfig({});
    config.infrastructure.contextBudget.enabled = false;
    setStaticContextInjectionBudget(config, 32);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-budget-disabled-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        channelSuccess: true,
      });
    }

    runtime.context.onTurnStart(sessionId, 1);
    const primary = await runtime.context.buildInjection(
      sessionId,
      "fix flaky test and keep complete context",
      {
        tokens: 900,
        contextWindow: 2000,
        percent: 0.45,
      },
      "leaf-a",
    );
    expect(primary.accepted).toBe(true);
    expect(primary.finalTokens).toBeGreaterThan(0);

    const supplemental = runtime.context.appendSupplementalInjection(
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-supplemental-budget-1";
    const usage = {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    };

    runtime.context.onTurnStart(sessionId, 1);
    const primary = await runtime.context.buildInjection(
      sessionId,
      "fix flaky tests",
      usage,
      "leaf-a",
    );
    const supplemental = runtime.context.appendSupplementalInjection(
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

    const otherScope = runtime.context.appendSupplementalInjection(
      sessionId,
      "y".repeat(120),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.context.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.context.appendSupplementalInjection(
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-supplemental-commit-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.context.onTurnStart(sessionId, 1);
    const first = runtime.context.appendSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(first.accepted).toBe(true);

    const second = runtime.context.appendSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(second.accepted).toBe(false);
    expect(second.droppedReason).toBe("budget_exhausted");

    const exhausted = runtime.context.appendSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(exhausted.accepted).toBe(false);
    expect(exhausted.droppedReason).toBe("budget_exhausted");

    const otherScope = runtime.context.appendSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.context.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.context.appendSupplementalInjection(
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-supplemental-duplicate-primary-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Preserve supplemental reservation after duplicate primary injection.",
    });

    runtime.context.onTurnStart(sessionId, 1);
    const primary = await runtime.context.buildInjection(
      sessionId,
      "stabilize duplicate scope budget",
      usage,
      "leaf-a",
    );
    expect(primary.accepted).toBe(true);

    const firstSupplemental = runtime.context.appendSupplementalInjection(
      sessionId,
      "s".repeat(28),
      usage,
      "leaf-a",
    );
    expect(firstSupplemental.accepted).toBe(true);
    expect(firstSupplemental.finalTokens).toBeGreaterThan(0);

    const duplicatePrimary = await runtime.context.buildInjection(
      sessionId,
      "stabilize duplicate scope budget",
      usage,
      "leaf-a",
    );
    expect(duplicatePrimary.accepted).toBe(false);

    const secondSupplemental = runtime.context.appendSupplementalInjection(
      sessionId,
      "z".repeat(4000),
      usage,
      "leaf-a",
    );
    expect(secondSupplemental.accepted).toBe(true);
    expect(secondSupplemental.finalTokens).toBeLessThanOrEqual(128 - firstSupplemental.finalTokens);
  });
});
