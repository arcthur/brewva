import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("cost budget", () => {
  test("allocates cost usage across tools based on call counts in the same turn", async () => {
    const workspace = createWorkspace("cost-allocation");
    writeConfig(workspace, createConfig({}));

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = "cost-allocation-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);

    runtime.authority.tools.tracking.markCall(sessionId, "read");
    runtime.authority.tools.tracking.markCall(sessionId, "read");
    runtime.authority.tools.tracking.markCall(sessionId, "grep");

    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 300,
      costUsd: 0.03,
    });

    const summary = runtime.inspect.cost.summary.get(sessionId);
    expect(summary.tools.read?.callCount).toBe(2);
    expect(summary.tools.grep?.callCount).toBe(1);
    expect(summary.tools.read?.allocatedTokens).toBeCloseTo(200, 3);
    expect(summary.tools.grep?.allocatedTokens).toBeCloseTo(100, 3);
    expect(summary.tools.read?.allocatedCostUsd).toBeCloseTo(0.02, 6);
    expect(summary.tools.grep?.allocatedCostUsd).toBeCloseTo(0.01, 6);
  });

  test("tracks skill/tool breakdown and blocks tools when budget action is block_tools", async () => {
    const workspace = createWorkspace("cost");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          costTracking: {
            maxCostUsdPerSession: 0.01,
            alertThresholdRatio: 0.5,
            actionOnExceed: "block_tools",
          },
        },
      }),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = "cost-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.02,
    });

    const summary = runtime.inspect.cost.summary.get(sessionId);
    expect(summary.totalCostUsd).toBeGreaterThan(0.01);
    expect(summary.budget.blocked).toBe(true);
    requireDefined(summary.skills["(none)"], "expected default skill bucket in cost summary");
    expect(summary.tools.edit?.callCount).toBe(1);

    const access = runtime.inspect.tools.access.check(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.inspect.tools.access.check(sessionId, "workbench_compact").allowed).toBe(true);
  });

  test("enforces session cost budget status consistently with tool access checks", async () => {
    const workspace = createWorkspace("cost-budget-consistency");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          costTracking: {
            maxCostUsdPerSession: 0.001,
            alertThresholdRatio: 0.5,
            actionOnExceed: "block_tools",
          },
        },
      }),
    );
    mkdirSync(join(workspace, "skills/core/implementation"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/core/implementation/SKILL.md"),
      `---
name: implementation
description: test implementation skill
tags: [implementation]
selection:
  when_to_use: Use when the task needs the routed test skill.
intent:
  outputs: [change_set]
  output_contracts:
    change_set:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects: [workspace_read, workspace_write]
resources:
  default_lease:
    max_tool_calls: 20
    max_tokens: 20000
  hard_ceiling:
    max_tool_calls: 30
    max_tokens: 30000
execution_hints:
  preferred_tools: [read, edit]
  fallback_tools: []
consumes: []
requires: []
---
implementation`,
      "utf8",
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = "cost-budget-consistency-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.tools.tracking.markCall(sessionId, "read");
    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 60,
      costUsd: 0.002,
    });
    const summary = runtime.inspect.cost.summary.get(sessionId);
    expect(summary.budget.blocked).toBe(true);

    const access = runtime.inspect.tools.access.check(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.inspect.tools.access.check(sessionId, "workbench_compact").allowed).toBe(true);
  });

  test("does not block tools when costTracking.enabled is false", () => {
    const workspace = createWorkspace("cost-disabled");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          costTracking: {
            enabled: false,
            maxCostUsdPerSession: 0.001,
            actionOnExceed: "block_tools",
          },
        },
      }),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = "cost-disabled-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.01,
    });

    const summary = runtime.inspect.cost.summary.get(sessionId);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.budget.blocked).toBe(false);
    expect(summary.budget.sessionExceeded).toBe(false);

    const access = runtime.inspect.tools.access.check(sessionId, "read");
    expect(access.allowed).toBe(true);
  });

  test("suppresses budget alerts when costTracking.enabled is false", () => {
    const workspace = createWorkspace("cost-disabled-alerts");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          costTracking: {
            enabled: false,
            maxCostUsdPerSession: 0.001,
            alertThresholdRatio: 0.5,
            actionOnExceed: "warn",
          },
        },
      }),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = "cost-no-alerts-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.01,
    });

    const summary = runtime.inspect.cost.summary.get(sessionId);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.alerts).toHaveLength(0);
  });
});
