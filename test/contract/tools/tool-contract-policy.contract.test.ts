import { describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  getToolActionPolicy,
  sameToolActionPolicy,
  type BrewvaConfig,
  type SkillContractOverride,
  type SkillRoutingScope,
  type ToolActionPolicy,
  type ToolEffectClass,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createPolicyWorkspace(name: string): string {
  const workspace = createTestWorkspace(name);
  const repoRoot = resolve(import.meta.dirname, "../../..");
  cpSync(resolve(repoRoot, "skills"), resolve(workspace, "skills"), { recursive: true });
  return workspace;
}

function createRuntime(
  workspace: string,
  options: {
    security?: Partial<BrewvaConfig["security"]>;
    skillOverrides?: Record<string, SkillContractOverride>;
    routingScopes?: SkillRoutingScope[];
  } = {},
): BrewvaRuntime {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.security = {
    ...config.security,
    ...options.security,
  };
  if (options.skillOverrides) {
    config.skills.overrides = {
      ...config.skills.overrides,
      ...options.skillOverrides,
    };
  }
  if (options.routingScopes) {
    config.skills.routing.scopes = [...new Set(options.routingScopes)];
  }
  config.infrastructure.events.enabled = true;
  config.ledger.path = ".orchestrator/ledger/evidence.jsonl";
  config.infrastructure.events.dir = ".orchestrator/events";
  return new BrewvaRuntime({ cwd: workspace, config });
}

function customActionPolicy(
  effects: ToolEffectClass[],
  riskLevel: ToolActionPolicy["riskLevel"] = "high",
): ToolActionPolicy {
  return {
    actionClass: effects.includes("local_exec") ? "local_exec_effectful" : "external_side_effect",
    riskLevel,
    defaultAdmission: "ask",
    maxAdmission: "ask",
    receiptPolicy: { kind: "commitment", required: true },
    recoveryPolicy: { kind: "manual_recovery_evidence" },
    effectClasses: effects,
  };
}

describe("effect governance policy modes", () => {
  test("standard mode warns on unauthorized non-control-plane effects and deduplicates the warning", () => {
    const workspace = createPolicyWorkspace("effect-governance-warn");
    const runtime = createRuntime(workspace, { security: { mode: "standard" } });
    const sessionId = "effect-governance-warn-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      0,
    );

    expect(runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      1,
    );

    expect(runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      1,
    );
  });

  test("warning state survives restart without re-emitting duplicates", () => {
    const workspace = createPolicyWorkspace("effect-governance-warn-restart");
    const options = { security: { mode: "standard" as const } };
    const sessionId = "effect-governance-warn-restart-1";

    const runtime = createRuntime(workspace, options);
    runtime.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    runtime.maintain.context.onTurnStart(sessionId, 1);
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      0,
    );
    expect(runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      1,
    );

    const reloaded = createRuntime(workspace, options);
    reloaded.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    reloaded.maintain.context.onTurnStart(sessionId, 1);
    expect(reloaded.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(
      reloaded.inspect.events.query(sessionId, { type: "tool_contract_warning" }),
    ).toHaveLength(1);
    expect(reloaded.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(true);
    expect(
      reloaded.inspect.events.query(sessionId, { type: "tool_contract_warning" }),
    ).toHaveLength(1);
  });

  test("denied effects stay blocked even in permissive mode", () => {
    const workspace = createPolicyWorkspace("effect-governance-permissive-denied");
    const runtime = createRuntime(workspace, {
      security: { mode: "permissive" },
      skillOverrides: {
        design: {
          effects: {
            deniedEffects: ["workspace_read"],
          },
        },
      },
    });
    const sessionId = "effect-governance-permissive-denied-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const blocked = runtime.inspect.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("denied effects");
    expect(runtime.inspect.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);
  });

  test("strict mode blocks unauthorized non-control-plane effects while control-plane tools stay allowed", () => {
    const workspace = createPolicyWorkspace("effect-governance-enforce");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-enforce-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const blocked = runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("unauthorized effects");
    expect(runtime.inspect.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);

    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "resource_lease").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "optimization_continuity").allowed).toBe(
      true,
    );
    expect(runtime.inspect.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "rollback_last_patch").allowed).toBe(true);
  });

  test("standard mode with effect enforcement override blocks unauthorized effects", () => {
    const workspace = createPolicyWorkspace("effect-governance-standard-override");
    const runtime = createRuntime(workspace, {
      security: {
        mode: "standard",
        enforcement: {
          effectAuthorizationMode: "enforce",
          skillMaxTokensMode: "inherit",
          skillMaxToolCallsMode: "inherit",
          skillMaxParallelMode: "inherit",
        },
      },
    });
    const sessionId = "effect-governance-standard-override-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    const blocked = runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("unauthorized effects");
  });

  test("strict mode blocks effectful-unknown tools until an exact action policy exists", () => {
    const workspace = createPolicyWorkspace("effect-governance-unknown-tool");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-unknown-tool-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const access = runtime.inspect.tools.checkAccess(sessionId, "custom_tool");
    expect(access.allowed).toBe(false);
    expect(access.reason).toContain("exact action policy");
    expect(runtime.inspect.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(
      1,
    );
    expect(runtime.inspect.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);
  });

  test("standard mode fails closed when an effectful tool has no action policy", () => {
    const workspace = createPolicyWorkspace("effect-governance-standard-missing-policy");
    const runtime = createRuntime(workspace, { security: { mode: "standard" } });
    const sessionId = "effect-governance-standard-missing-policy-1";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const started = runtime.authority.tools.start({
      sessionId,
      toolCallId: "tc-missing-policy",
      toolName: "custom_tool",
      args: { value: "opaque" },
    });

    expect(started.allowed).toBe(false);
    expect(started.reason).toContain("exact action policy");
    expect(
      runtime.inspect.events.query(sessionId, { type: "tool_effect_gate_selected" }).at(-1)
        ?.payload,
    ).toMatchObject({
      toolName: "custom_tool",
      actionClass: null,
      requiresApproval: true,
    });
  });

  test("custom action policies let strict mode enforce third-party tools", () => {
    const workspace = createPolicyWorkspace("effect-governance-custom-descriptor");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-custom-descriptor-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_exec_tool",
      customActionPolicy(["local_exec"]),
    );
    try {
      expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
      const blocked = runtime.inspect.tools.checkAccess(sessionId, "custom_exec_tool");
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("local_exec");
    } finally {
      runtime.maintain.tools.unregisterActionPolicy("custom_exec_tool");
    }
  });

  test("invalid action policies fail closed at registration time", () => {
    const workspace = createPolicyWorkspace("effect-governance-invalid-descriptor");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });

    expect(() =>
      runtime.maintain.tools.registerActionPolicy("custom_invalid_tool", {
        actionClass: "credential_access",
        riskLevel: "critical",
        defaultAdmission: "ask",
        maxAdmission: "allow",
        receiptPolicy: { kind: "security_audit", required: true },
        recoveryPolicy: { kind: "none" },
        effectClasses: ["credential_access"],
      }),
    ).toThrow("critical action policy cannot be relaxed below ask");
  });

  test("explainAccess uses runtime-scoped action policies", () => {
    const workspace = createPolicyWorkspace("effect-governance-explain-custom");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-explain-custom-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_exec_tool",
      customActionPolicy(["local_exec"]),
    );
    try {
      expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
      const explained = runtime.inspect.tools.explainAccess({
        sessionId,
        toolName: "custom_exec_tool",
      });
      expect(explained.allowed).toBe(false);
      expect(explained.reason).toContain("local_exec");
    } finally {
      runtime.maintain.tools.unregisterActionPolicy("custom_exec_tool");
    }
  });

  test("hint-based governance emits governance_metadata_missing once until exact policy is added", () => {
    const workspace = createPolicyWorkspace("effect-governance-hint-metadata");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-hint-metadata-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const first = runtime.inspect.tools.checkAccess(sessionId, "custom_query_tool");
    const second = runtime.inspect.tools.checkAccess(sessionId, "custom_query_tool");

    expect(first.allowed).toBe(false);
    expect(first.reason).toContain("exact action policy");
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("exact action policy");
    const events = runtime.inspect.events.query(sessionId, { type: "governance_metadata_missing" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      skill: "design",
      toolName: "custom_query_tool",
      resolution: "hint",
    });
  });

  test("effectful hint matches are blocked until exact action policy is registered", () => {
    const workspace = createPolicyWorkspace("effect-governance-hint-effectful");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-hint-effectful-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

    const access = runtime.inspect.tools.checkAccess(sessionId, "custom_command_runner");

    expect(access.allowed).toBe(false);
    expect(access.reason).toContain("exact action policy");
    const metadataEvents = runtime.inspect.events.query(sessionId, {
      type: "governance_metadata_missing",
    });
    expect(metadataEvents).toHaveLength(1);
    expect(metadataEvents[0]?.payload).toMatchObject({
      skill: "design",
      toolName: "custom_command_runner",
      resolution: "hint",
    });
  });

  test("governance_metadata_missing deduplication survives restart", () => {
    const workspace = createPolicyWorkspace("effect-governance-hint-restart");
    const options = { security: { mode: "strict" as const } };
    const sessionId = "effect-governance-hint-restart-1";

    const runtime = createRuntime(workspace, options);
    runtime.maintain.context.onTurnStart(sessionId, 1);
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    const initial = runtime.inspect.tools.checkAccess(sessionId, "custom_query_tool");
    expect(initial.allowed).toBe(false);
    expect(initial.reason).toContain("exact action policy");
    expect(
      runtime.inspect.events.query(sessionId, { type: "governance_metadata_missing" }),
    ).toHaveLength(1);

    const reloaded = createRuntime(workspace, options);
    reloaded.maintain.context.onTurnStart(sessionId, 1);
    const afterRestart = reloaded.inspect.tools.checkAccess(sessionId, "custom_query_tool");
    expect(afterRestart.allowed).toBe(false);
    expect(afterRestart.reason).toContain("exact action policy");
    expect(
      reloaded.inspect.events.query(sessionId, { type: "governance_metadata_missing" }),
    ).toHaveLength(1);
  });

  test("runtime-scoped action policies do not leak across runtime instances", () => {
    const runtimeA = createRuntime(createPolicyWorkspace("effect-governance-runtime-a"), {
      security: { mode: "strict" },
    });
    const runtimeB = createRuntime(createPolicyWorkspace("effect-governance-runtime-b"), {
      security: { mode: "strict" },
    });

    runtimeA.maintain.tools.registerActionPolicy(
      "custom_remote_tool",
      customActionPolicy(["local_exec"]),
    );
    try {
      expect(runtimeA.authority.skills.activate("runtime-a", "design").ok).toBe(true);
      expect(runtimeB.authority.skills.activate("runtime-b", "design").ok).toBe(true);

      const blocked = runtimeA.inspect.tools.checkAccess("runtime-a", "custom_remote_tool");
      const warned = runtimeB.inspect.tools.checkAccess("runtime-b", "custom_remote_tool");

      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("local_exec");
      expect(warned.allowed).toBe(false);
      expect(warned.reason).toContain("exact action policy");
      expect(
        runtimeA.inspect.events.query("runtime-a", { type: "tool_contract_warning" }),
      ).toHaveLength(0);
      expect(
        runtimeB.inspect.events.query("runtime-b", { type: "tool_contract_warning" }),
      ).toHaveLength(1);
    } finally {
      runtimeA.maintain.tools.unregisterActionPolicy("custom_remote_tool");
    }
  });

  test("command heuristics no longer misclassify generic process_* tool names as local exec policy", () => {
    expect(getToolActionPolicy("process")).toMatchObject({
      actionClass: "local_exec_effectful",
      riskLevel: "medium",
      defaultAdmission: "ask",
    });
    expect(getToolActionPolicy("process_image")).toBeUndefined();
    expect(getToolActionPolicy("data_process")).toBeUndefined();
  });

  test("narrative_memory resolves action-level governance for inspect and promote actions", () => {
    const workspace = createPolicyWorkspace("effect-governance-narrative-memory-actions");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-narrative-memory-actions-1";

    runtime.maintain.context.onTurnStart(sessionId, 1);

    expect(runtime.inspect.tools.getActionPolicy("narrative_memory")).toMatchObject({
      actionClass: "memory_write",
      riskLevel: "medium",
      recoveryPolicy: { kind: "none" },
    });
    expect(
      runtime.inspect.tools.getActionPolicy("narrative_memory", {
        action: "list",
      }),
    ).toMatchObject({
      actionClass: "runtime_observe",
      riskLevel: "low",
      defaultAdmission: "allow",
    });
    expect(
      runtime.inspect.tools.getActionPolicy("narrative_memory", {
        action: "promote",
      }),
    ).toMatchObject({
      actionClass: "memory_write",
      effectClasses: ["memory_write", "workspace_write"],
      recoveryPolicy: { kind: "none" },
    });

    const inspectStart = runtime.authority.tools.start({
      sessionId,
      toolCallId: "tc-narrative-inspect",
      toolName: "narrative_memory",
      args: { action: "list" },
    });
    expect(inspectStart.allowed).toBe(true);
    expect(inspectStart.boundary).toBe("safe");
    expect(inspectStart.mutationReceipt).toBeUndefined();

    const promoteStart = runtime.authority.tools.start({
      sessionId,
      toolCallId: "tc-narrative-promote",
      toolName: "narrative_memory",
      args: { action: "promote", record_id: "narrative-1" },
    });
    expect(promoteStart.allowed).toBe(true);
    expect(promoteStart.boundary).toBe("effectful");
    expect(promoteStart.mutationReceipt).toBeUndefined();
  });

  test("recall tools expose explicit read and curation action policies", () => {
    expect(getToolActionPolicy("recall_search")).toMatchObject({
      actionClass: "workspace_read",
      riskLevel: "low",
    });
    expect(getToolActionPolicy("recall_curate")).toMatchObject({
      actionClass: "memory_write",
      riskLevel: "medium",
      recoveryPolicy: { kind: "none" },
      requiredRoutingScopes: ["operator", "meta"],
    });
  });

  test("recall_curate requires an operator or meta routing scope", () => {
    const workspace = createPolicyWorkspace("recall-curate-routing-scope");
    const sessionId = "recall-curate-routing-scope-1";

    const defaultRuntime = createRuntime(workspace);
    defaultRuntime.maintain.context.onTurnStart(sessionId, 1);
    const blocked = defaultRuntime.inspect.tools.checkAccess(sessionId, "recall_curate");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("routing scopes");

    const operatorRuntime = createRuntime(workspace, {
      routingScopes: ["core", "domain", "operator"],
    });
    operatorRuntime.maintain.context.onTurnStart(sessionId, 1);
    expect(operatorRuntime.inspect.tools.checkAccess(sessionId, "recall_curate").allowed).toBe(
      true,
    );
  });

  test("tool action policy equality includes required routing scopes", () => {
    expect(
      sameToolActionPolicy(
        {
          actionClass: "memory_write",
          riskLevel: "medium",
          defaultAdmission: "allow",
          maxAdmission: "ask",
          receiptPolicy: { kind: "control_plane", required: true },
          recoveryPolicy: { kind: "none" },
          effectClasses: ["memory_write"],
          requiredRoutingScopes: ["operator"],
        },
        {
          actionClass: "memory_write",
          riskLevel: "medium",
          defaultAdmission: "allow",
          maxAdmission: "ask",
          receiptPolicy: { kind: "control_plane", required: true },
          recoveryPolicy: { kind: "none" },
          effectClasses: ["memory_write"],
          requiredRoutingScopes: ["meta"],
        },
      ),
    ).toBe(false);

    expect(
      sameToolActionPolicy(
        {
          actionClass: "memory_write",
          riskLevel: "medium",
          defaultAdmission: "allow",
          maxAdmission: "ask",
          receiptPolicy: { kind: "control_plane", required: true },
          recoveryPolicy: { kind: "none" },
          effectClasses: ["memory_write"],
          requiredRoutingScopes: ["meta", "operator"],
        },
        {
          actionClass: "memory_write",
          riskLevel: "medium",
          defaultAdmission: "allow",
          maxAdmission: "ask",
          receiptPolicy: { kind: "control_plane", required: true },
          recoveryPolicy: { kind: "none" },
          effectClasses: ["memory_write"],
          requiredRoutingScopes: ["operator", "meta"],
        },
      ),
    ).toBe(true);
  });
});

describe("skill resource budgets", () => {
  test("maxTokens warnings are deduplicated in standard mode", () => {
    const workspace = createPolicyWorkspace("skill-max-tokens-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1_000_000, maxTokens: 10 },
          },
        },
      },
    });
    const sessionId = "skill-max-tokens-warn-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);

    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(
      1,
    );

    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(
      1,
    );
  });

  test("strict mode blocks non-lifecycle tools when maxTokens is exceeded", () => {
    const workspace = createPolicyWorkspace("skill-max-tokens-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1_000_000, maxTokens: 10 },
          },
        },
      },
    });
    const sessionId = "skill-max-tokens-enforce-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);

    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    const blocked = runtime.inspect.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("exceeded maxTokens");

    expect(runtime.inspect.tools.checkAccess(sessionId, "resource_lease").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "skill_load").allowed).toBe(true);
  });

  test("maxToolCalls warnings are deduplicated in standard mode", () => {
    const workspace = createPolicyWorkspace("skill-max-tool-calls-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-warn-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.authority.tools.markCall(sessionId, "read");

    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(
      1,
    );

    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.inspect.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(
      1,
    );
  });

  test("strict mode blocks non-lifecycle tools when maxToolCalls is exceeded", () => {
    const workspace = createPolicyWorkspace("skill-max-tool-calls-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-enforce-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.authority.tools.markCall(sessionId, "read");

    const blocked = runtime.inspect.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("exceeded maxToolCalls");
  });

  test("strict mode keeps lifecycle completion tools usable when maxToolCalls is exceeded", () => {
    const workspace = createPolicyWorkspace("skill-max-tool-calls-lifecycle");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-lifecycle-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.authority.tools.markCall(sessionId, "read");

    expect(runtime.inspect.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "skill_load").allowed).toBe(true);
  });
});

describe("skill parallel lease budgets", () => {
  test("maxParallel warnings are emitted once in standard mode", () => {
    const workspace = createPolicyWorkspace("skill-max-parallel-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxParallel: 1 },
          },
        },
      },
    });
    const sessionId = "skill-max-parallel-warn-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);

    expect(runtime.authority.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    expect(runtime.authority.tools.acquireParallelSlot(sessionId, "run-2").accepted).toBe(true);
    expect(
      runtime.inspect.events.query(sessionId, { type: "skill_parallel_warning" }),
    ).toHaveLength(1);
  });

  test("strict mode rejects parallel slots beyond the effective lease", () => {
    const workspace = createPolicyWorkspace("skill-max-parallel-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxParallel: 1 },
          },
        },
      },
    });
    const sessionId = "skill-max-parallel-enforce-1";

    expect(runtime.authority.skills.activate(sessionId, "implementation").ok).toBe(true);

    expect(runtime.authority.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    const rejected = runtime.authority.tools.acquireParallelSlot(sessionId, "run-2");
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("skill_max_parallel");
  });
});

describe("resource lease negotiation", () => {
  test("resource leases require an active skill scope", () => {
    const workspace = createPolicyWorkspace("resource-lease-active-skill");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "resource-lease-active-skill-1";

    const lease = runtime.authority.tools.requestResourceLease(sessionId, {
      reason: "Need one extra read call.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });

    expect(lease.ok).toBe(false);
    if (!lease.ok) {
      expect(lease.error).toContain("active skill");
    }
    expect(runtime.inspect.tools.listResourceLeases(sessionId)).toHaveLength(0);
  });

  test("resource leases do not alter effect authorization", () => {
    const workspace = createPolicyWorkspace("resource-lease-effect");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 2, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-effect-1";

    runtime.maintain.tools.registerActionPolicy(
      "custom_network_tool",
      customActionPolicy(["external_network"]),
    );
    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(false);

    const lease = runtime.authority.tools.requestResourceLease(sessionId, {
      reason: "Need one more read call while staying within the design skill boundary.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 2,
    });
    expect(lease.ok).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "custom_network_tool").allowed).toBe(false);
    expect(runtime.inspect.tools.listResourceLeases(sessionId)).toHaveLength(1);
  });

  test("resource leases can expand maxToolCalls within the hard ceiling", () => {
    const workspace = createPolicyWorkspace("resource-lease-budget");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 2, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-budget-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    runtime.authority.tools.markCall(sessionId, "read");
    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(false);

    const lease = runtime.authority.tools.requestResourceLease(sessionId, {
      reason: "Need one more read tool call to finish inventory.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });
    expect(lease.ok).toBe(true);
    expect(runtime.inspect.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
  });

  test("resource leases can be cancelled explicitly and disappear from the active budget view", () => {
    const workspace = createPolicyWorkspace("resource-lease-cancel");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 2, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-cancel-1";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    const granted = runtime.authority.tools.requestResourceLease(sessionId, {
      reason: "Need one additional read budget while wrapping the review.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 2,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) {
      return;
    }

    const cancelled = runtime.authority.tools.cancelResourceLease(
      sessionId,
      granted.lease.id,
      "review_complete",
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      return;
    }

    expect(cancelled.lease.status).toBe("cancelled");
    expect(cancelled.lease.cancelledReason).toBe("review_complete");
    expect(runtime.inspect.tools.listResourceLeases(sessionId)).toHaveLength(0);
    expect(runtime.inspect.tools.listResourceLeases(sessionId, { includeInactive: true })).toEqual([
      expect.objectContaining({
        id: granted.lease.id,
        status: "cancelled",
        cancelledReason: "review_complete",
      }),
    ]);
    expect(
      runtime.inspect.events.query(sessionId, { type: "resource_lease_granted" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, { type: "resource_lease_cancelled" }),
    ).toHaveLength(1);
  });

  test("resource leases explain when hard ceilings leave no headroom", () => {
    const workspace = createPolicyWorkspace("resource-lease-no-headroom");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-no-headroom-1";

    expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
    const lease = runtime.authority.tools.requestResourceLease(sessionId, {
      reason: "Need one more call.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });

    expect(lease.ok).toBe(false);
    if (!lease.ok) {
      expect(lease.error).toContain("hard_ceiling");
    }
  });
});
