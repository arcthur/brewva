import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createOperatorRuntimePort } from "@brewva/brewva-runtime";
import { createTrustedLocalGovernancePort } from "@brewva/brewva-runtime/governance";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("context compaction gate", () => {
  test("blocks non-workbench_compact tools at critical pressure and unblocks after compaction", async () => {
    const workspace = createWorkspace("core-compaction-gate");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          contextBudget: {
            enabled: true,
            thresholds: {
              compactionFloorPercent: 0.8,
              compactionCeilingPercent: 0.8,
              compactionHeadroomTokens: 24_000,
              hardLimitFloorPercent: 0.9,
              hardLimitCeilingPercent: 0.9,
              hardLimitHeadroomTokens: 8_000,
            },
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = "core-compaction-gate-1";
    createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(sessionId, 3);

    const usage = {
      tokens: 95,
      contextWindow: 100,
      percent: 0.95,
    };
    createOperatorRuntimePort(runtime).operator.context.usage.observe(sessionId, usage);

    const blocked = runtime.authority.tools.invocation.start({
      sessionId,
      toolCallId: "tc-blocked",
      toolName: "exec",
      args: { command: "echo blocked" },
      usage,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("workbench_compact");
    expect(
      runtime.inspect.events.records.query(sessionId, {
        type: "context_compaction_gate_blocked_tool",
      }),
    ).toHaveLength(1);

    const compactAllowed = runtime.authority.tools.invocation.start({
      sessionId,
      toolCallId: "tc-compact",
      toolName: "workbench_compact",
      args: { reason: "critical" },
      usage,
    });
    expect(compactAllowed.allowed).toBe(true);

    runtime.authority.session.compaction.commit(sessionId, {
      compactId: "cmp-core-gate",
      sanitizedSummary: "Keep only the active recovery baseline.",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: usage.tokens,
      toTokens: 40,
      origin: "auto_compaction",
    });

    const unblocked = runtime.authority.tools.invocation.start({
      sessionId,
      toolCallId: "tc-after-compact",
      toolName: "exec",
      args: { command: "echo ok" },
      usage,
    });
    expect(unblocked.allowed).toBe(true);
  });
});
