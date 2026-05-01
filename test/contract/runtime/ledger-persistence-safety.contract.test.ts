import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("ledger persistence safety", () => {
  test("checkpointEveryTurns compacts session ledger and preserves local integrity", async () => {
    const workspace = createWorkspace("ledger");
    writeConfig(
      workspace,
      createConfig({
        ledger: {
          path: ".orchestrator/ledger/evidence.jsonl",
          checkpointEveryTurns: 3,
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "ledger-1";
    for (let i = 0; i < 5; i += 1) {
      runtime.maintain.context.onTurnStart(sessionId, i + 1);
      runtime.authority.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${i}` },
        outputText: `ok-${i}`,
        channelSuccess: true,
      });
    }

    const rows = runtime.inspect.ledger.listRows(sessionId);
    expect(rows.map((row) => row.tool)).toContain("ledger_checkpoint");
    expect(rows.length).toBeLessThan(6);

    const integrity = runtime.inspect.ledger.verifyIntegrity(sessionId);
    expect(integrity.valid).toBe(true);
  });

  test("secret values are redacted before ledger persistence", async () => {
    const workspace = createWorkspace("redact");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "redact-1";
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "read",
      args: { token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
      outputText: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      channelSuccess: true,
      metadata: {
        nested: {
          key: "AKIA1234567890ABCDEF",
        },
      },
    });

    const ledgerText = readFileSync(runtime.inspect.ledger.getPath(), "utf8");
    expect(ledgerText.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(ledgerText.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(ledgerText.includes("AKIA1234567890ABCDEF")).toBe(false);
  });

  test("flags invalid JSON lines in persisted ledger integrity checks", async () => {
    const workspace = createWorkspace("ledger-bad-lines");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "ledger-bad-lines-1";
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "read",
      args: { path: "src/a.ts" },
      outputText: "ok-a",
      channelSuccess: true,
    });

    appendFileSync(runtime.inspect.ledger.getPath(), "\nnot-json", "utf8");

    const rows = runtime.inspect.ledger.listRows(sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tool).toBe("read");

    const integrity = runtime.inspect.ledger.verifyIntegrity(sessionId);
    expect(integrity).toEqual({
      valid: false,
      reason: "ledger_row_malformed_json:2",
    });
  });

  test("keeps row turns aligned with turn_start instead of tool-result sequence", async () => {
    const workspace = createWorkspace("turn-alignment");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
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
