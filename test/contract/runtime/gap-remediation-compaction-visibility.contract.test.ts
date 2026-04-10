import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: compaction visibility", () => {
  test("injects the latest history-view baseline after repeated compactions", async () => {
    const workspace = createWorkspace("context-compaction-summary");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-summary-1";

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-1",
      sanitizedSummary: "Keep failing tests, active objective, and latest diff only.",
      summaryDigest: "unused",
      sourceTurn: 0,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 1600,
      toTokens: 500,
      origin: "auto_compaction",
    });

    const first = await runtime.maintain.context.buildInjection(sessionId, "fix flaky tests", {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    });
    expect(first.accepted).toBe(true);
    expect(first.text).toContain("[HistoryViewBaseline]");
    expect(first.text).toContain("active objective");

    const second = await runtime.maintain.context.buildInjection(
      sessionId,
      "continue fixing tests",
      {
        tokens: 820,
        contextWindow: 4000,
        percent: 0.21,
      },
    );
    expect(second.accepted).toBe(false);
    expect(second.text).toBe("");

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-2",
      sanitizedSummary:
        "Preserve unresolved assertion mismatch and the last failing command output.",
      summaryDigest: "unused",
      sourceTurn: 0,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 1700,
      toTokens: 480,
      origin: "auto_compaction",
    });

    const third = await runtime.maintain.context.buildInjection(sessionId, "resume bugfix", {
      tokens: 790,
      contextWindow: 4000,
      percent: 0.19,
    });
    expect(third.accepted).toBe(true);
    expect(third.text).toContain("[HistoryViewBaseline]");
    expect(third.text).toContain("unresolved assertion mismatch");
    expect(third.text).not.toContain("Keep failing tests, active objective, and latest diff only.");
  });

  test("retains the history-view baseline after hard-limit recovery", async () => {
    const workspace = createWorkspace("context-hard-limit-retain");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-hard-limit-retain-1";

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-retain-1",
      sanitizedSummary: "Keep unresolved failures and active objective only.",
      summaryDigest: "unused",
      sourceTurn: 0,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 1800,
      toTokens: 520,
      origin: "auto_compaction",
    });

    const dropped = await runtime.maintain.context.buildInjection(sessionId, "resume task", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(dropped.accepted).toBe(false);
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const recovered = await runtime.maintain.context.buildInjection(sessionId, "resume task", {
      tokens: 600,
      contextWindow: 200_000,
      percent: 0.3,
    });
    expect(recovered.accepted).toBe(true);
    expect(recovered.text).toContain("[HistoryViewBaseline]");
    expect(recovered.text).toContain("active objective");
  });

  test("respects minTurnsBetweenCompaction when usage stays high", async () => {
    const workspace = createWorkspace("context-compaction-interval");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-interval-1";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(true);
    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-interval",
      sanitizedSummary: "Reset compaction interval state.",
      summaryDigest: "unused",
      sourceTurn: 1,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 820,
      toTokens: 120,
      origin: "auto_compaction",
    });

    runtime.maintain.context.onTurnStart(sessionId, 2);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);

    runtime.maintain.context.onTurnStart(sessionId, 3);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);
  });

  test("keeps ledger turn aligned with turn_start instead of tool-result sequence", async () => {
    const workspace = createWorkspace("turn-alignment");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "turn-alignment-1";

    runtime.maintain.context.onTurnStart(sessionId, 7);
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo one" },
      outputText: "one",
      channelSuccess: true,
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo two" },
      outputText: "two",
      channelSuccess: true,
    });
    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      costUsd: 0.001,
    });

    const rows = runtime.inspect.ledger
      .listRows(sessionId)
      .filter((row) => row.tool !== "ledger_checkpoint");
    expect(rows.length).toBe(3);
    expect(rows.map((row) => row.turn)).toEqual([7, 7, 7]);
  });

  test("writes session_compact evidence into ledger", async () => {
    const workspace = createWorkspace("context-compaction-ledger");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-ledger-1";

    runtime.maintain.context.onTurnStart(sessionId, 3);
    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-ledger",
      sanitizedSummary: "Persist the durable compaction receipt in the ledger.",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 8000,
      toTokens: 1200,
      origin: "auto_compaction",
    });

    const rows = runtime.inspect.ledger.listRows(sessionId);
    expect(rows.map((row) => row.tool)).toContain("brewva_session_compaction");
  });
});
