import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("context injection budget", () => {
  test("drops context injection when usage exceeds hard limit", async () => {
    const workspace = createWorkspace("context-budget");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });

    const decision = await runtime.maintain.context.buildInjection(
      "ctx-1",
      "fix broken test in runtime",
      {
        tokens: 195_000,
        contextWindow: 200_000,
        percent: 0.975,
      },
    );
    expect(decision.accepted).toBe(false);
  });

  test("deduplicates per branch scope and allows reinjection after compaction", async () => {
    const workspace = createWorkspace("context-injection-dedup");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    });
    const sessionId = "context-injection-dedup-1";
    runtime.inspect.ledger.getDigest = () =>
      "[Ledger Digest]\nrecords=0 pass=0 fail=0 inconclusive=0";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const first = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 600,
        contextWindow: 4000,
        percent: 0.15,
      },
      { injectionScopeId: "leaf-a" },
    );
    expect(first.accepted).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);

    runtime.maintain.context.onTurnStart(sessionId, 2);
    const second = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 610,
        contextWindow: 4000,
        percent: 0.16,
      },
      { injectionScopeId: "leaf-a" },
    );
    expect(second.accepted).toBe(false);

    runtime.maintain.context.onTurnStart(sessionId, 3);
    const third = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 620,
        contextWindow: 4000,
        percent: 0.17,
      },
      { injectionScopeId: "leaf-b" },
    );
    expect(third.accepted).toBe(true);
    expect(third.text.length).toBeGreaterThan(0);

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-dedup-reset",
      sanitizedSummary: "Reset the history-view baseline after compaction.",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 1500,
      toTokens: 500,
      origin: "auto_compaction",
    });
    runtime.maintain.context.onTurnStart(sessionId, 4);

    const fourth = await runtime.maintain.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 630,
        contextWindow: 4000,
        percent: 0.18,
      },
      { injectionScopeId: "leaf-a" },
    );
    expect(fourth.accepted).toBe(true);
    expect(fourth.text.length).toBeGreaterThan(0);
  });

  test("truncates context injection to the configured effective injection budget", async () => {
    const workspace = createWorkspace("context-injection-truncate");
    const config = createConfig({});
    setStaticContextInjectionBudget(config, 32);
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "context-injection-truncate-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.authority.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        channelSuccess: true,
      });
    }

    const injection = await runtime.maintain.context.buildInjection(sessionId, "fix bug", {
      tokens: 1000,
      contextWindow: 2000,
      percent: 0.5,
    });
    expect(injection.accepted).toBe(true);
    expect(injection.finalTokens).toBeLessThanOrEqual(32);
    expect(injection.text.length).toBeGreaterThan(0);
  });
});
