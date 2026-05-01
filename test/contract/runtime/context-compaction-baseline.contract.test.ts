import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("context compaction baseline", () => {
  test("injects the latest history-view baseline after repeated compactions", async () => {
    const workspace = createWorkspace("context-compaction-summary");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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
});
