import { describe, expect, test } from "bun:test";
import {
  EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import { setStaticContextStatusThresholds } from "../../../fixtures/config.js";
import {
  createMockExtensionApi,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandler,
  invokeHandlerAsync,
  registerContextTransform,
} from "./context-transform.helpers.js";

function authorityBasis(input: {
  toolName: string;
  actionClass: string;
  effects: string[];
  recoveryPreparation: string;
  recoverability: string;
  visibility: string;
  requiresApproval: boolean;
  receiptRequired: boolean;
  effectiveAdmission: string;
}) {
  return {
    schema: "brewva.effect_authority_basis.v2",
    toolName: input.toolName,
    boundary: input.receiptRequired ? "effectful" : "safe",
    authoritySource: "exact",
    actionClass: input.actionClass,
    riskLevel: input.requiresApproval ? "high" : "low",
    effectiveAdmission: input.effectiveAdmission,
    effects: input.effects,
    requiresApproval: input.requiresApproval,
    receiptRequired: input.receiptRequired,
    recoveryPreparation: input.recoveryPreparation,
    commitmentPosture: {
      recoverability: input.recoverability,
      visibility: input.visibility,
      evidenceSources: ["action_policy"],
      warnings: [],
    },
    invariantBasis: ["exact_action_policy_required"],
    overlayBasis: [`action_policy:${input.actionClass}`],
    runtimeBasis: ["runtime_capability_scope"],
    receiptBasis: input.receiptRequired ? ["receipt:mutation"] : ["receipt:audit"],
  };
}

function reversibleMutationReceipt() {
  return {
    id: "mutation:tool:edit:edit-call:1",
    subject: { kind: "tool", toolName: "edit", toolCallId: "edit-call" },
    boundary: "effectful",
    strategy: "workspace_patchset",
    rollbackKind: "patchset",
    effects: ["workspace_write"],
    turn: 0,
    timestamp: 1_800_000_001_000,
  };
}

describe("context transform session hook contract", () => {
  test("renders the critical gate without skill routing events", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventPayloads: Array<{ type: string; payload?: Record<string, unknown> }> = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextStatusThresholds(config, { hardRatio: 0.8 });
      }),
      events: {
        record: (input: { type: string; payload?: object }) => {
          eventPayloads.push({
            type: input.type,
            payload: input.payload as Record<string, unknown> | undefined,
          });
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "critical-turn",
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => "s-critical-short-circuit",
        },
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );

    expect(result.message?.content).toContain("[ContextCompactionGate]");
    expect(eventPayloads.map((event) => event.type)).not.toContain("skill_routing_selection");
  });

  test("renders the previous turn consequence digest after reversible mutation, external deferral, and rollback", async () => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.events.level = "debug";
      }),
    });
    const sessionId = "s-consequence-digest-e2e";
    const sessionManager = {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-consequence",
    };

    registerContextTransform(api, runtime);

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
      payload: {
        toolName: "edit",
        toolCallId: "edit-call",
        decision: "allow",
        allowed: true,
        manifestBasis: authorityBasis({
          toolName: "edit",
          actionClass: "workspace_patch",
          effects: ["workspace_write"],
          recoveryPreparation: "workspace_patchset",
          recoverability: "manual_recovery",
          visibility: "workspace_visible",
          requiresApproval: false,
          receiptRequired: true,
          effectiveAdmission: "allow",
        }),
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
      payload: { receipt: reversibleMutationReceipt() },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
      payload: {
        receipt: reversibleMutationReceipt(),
        changed: true,
        patchSetId: "patch-edit",
        rollbackRef: "patchset://patch-edit",
        channelSuccess: true,
        verdict: "pass",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
      payload: {
        toolName: "publish",
        toolCallId: "publish-call",
        decision: "block",
        reason: "external effect requires operator approval",
        allowed: false,
        manifestBasis: authorityBasis({
          toolName: "publish",
          actionClass: "external_side_effect",
          effects: ["external_side_effect"],
          recoveryPreparation: "manual",
          recoverability: "manual_recovery",
          visibility: "externally_observable",
          requiresApproval: true,
          receiptRequired: true,
          effectiveAdmission: "ask",
        }),
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: TOOL_CALL_BLOCKED_EVENT_TYPE,
      payload: {
        schema: "brewva.tool_call_blocked.v1",
        toolName: "publish",
        toolCallId: "publish-call",
        decision: "defer",
        reason: "effect_commitment_pending_operator_approval:req-e2e",
        requestId: "req-e2e",
        manifestBasis: authorityBasis({
          toolName: "publish",
          actionClass: "external_side_effect",
          effects: ["external_side_effect"],
          recoveryPreparation: "manual",
          recoverability: "manual_recovery",
          visibility: "externally_observable",
          requiresApproval: true,
          receiptRequired: true,
          effectiveAdmission: "ask",
        }),
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: SESSION_TURN_TRANSITION_EVENT_TYPE,
      payload: {
        reason: "effect_commitment_pending",
        status: "entered",
        family: "approval",
        sequence: 1,
        sourceEventId: "tool-call-blocked-e2e",
        sourceEventType: TOOL_CALL_BLOCKED_EVENT_TYPE,
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 0,
      type: REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
      payload: {
        receiptId: "mutation:tool:edit:edit-call:1",
        patchSetId: "patch-edit",
        toolName: "edit",
        ok: true,
      },
    });

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 1_800_000_001_100 },
      {
        sessionManager,
      },
    );
    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1, timestamp: 1_800_000_001_200 },
      {
        sessionManager,
      },
    );

    const result = await invokeHandlerAsync<{
      message?: { content?: string; details?: { dynamicTail?: { blockIds?: string[] } } };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue after effects",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1_200, contextWindow: 200_000, percent: 0.006 }),
      },
    );

    const content = result.message?.content ?? "";
    expect(result.message?.details?.dynamicTail?.blockIds).toContain("turn-consequence-digest");
    expect(content).toContain("[TurnConsequenceDigest]");
    expect(content).toContain("executed tool=edit");
    expect(content).toContain("rollback_available=false");
    expect(content).toContain("decision=defer");
    expect(content).toContain("visibility=externally_observable");
    expect(content).toContain("recovery kind=rollback");
    expect(content).not.toMatch(/\b(should|must|please|consider)\b/iu);
  });

  test("arms the critical gate for non-session_compact flows and clears it after compaction", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextStatusThresholds(config, { hardRatio: 0.8 });
      }),
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
      },
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });
    const capturedCompactions: Array<Record<string, unknown>> = [];
    const originalCommitCompaction = runtime.authority.session.compaction.commit.bind(
      runtime.authority.session,
    );
    runtime.authority.session.compaction.commit = (sessionId, payload) => {
      capturedCompactions.push(payload as unknown as Record<string, unknown>);
      return originalCommitCompaction(sessionId, payload);
    };

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-gate",
    };

    const before = await invokeHandlerAsync<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-1",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );

    expect(before.message?.content).toContain("[ContextCompactionGate]");
    expect(before.message?.content).toContain("[Context Status]");
    expect(before.message?.content).toContain("forced_compaction: yes");
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
    expect(eventTypes).toContain("context_composed");
    expect(eventTypes).not.toContain("context_compaction_advisory");

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1 },
      {
        sessionManager,
      },
    );

    await invokeHandlerAsync(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-1",
          summary: "Keep active goals only.",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1200, contextWindow: 4096, percent: 0.29 }),
      },
    );

    expect(capturedCompactions).toHaveLength(1);
    expect(capturedCompactions[0]?.compactId).toBe("cmp-entry-1");
    expect(capturedCompactions[0]?.sanitizedSummary).toBe("Keep active goals only.");
    expect(capturedCompactions[0]?.toTokens).toBe(1200);
    expect(eventTypes).toContain("session_compact");
    expect(eventTypes).toContain("context_compaction_gate_cleared");
  });

  test("keeps the gate disarmed immediately after a recent compaction", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextStatusThresholds(config, { hardRatio: 0.8 });
      }),
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-recent-compact",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-recent",
          summary: "recent compaction",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1000, contextWindow: 4096, percent: 0.24 }),
      },
    );

    const before = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-after-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt).toContain("[Brewva Context Contract]");
    expect(before.message?.content).not.toContain("[OperationalDiagnostics]");
    expect(before.message?.content).not.toContain("[ContextCompactionGate]");
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });

  test("keeps the gate disarmed within the compaction window and rearms after it expires", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextStatusThresholds(config, { hardRatio: 0.8 });
      }),
      events: {
        query: () => [],
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-window",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-window",
          summary: "window compact",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 500, contextWindow: 4096, percent: 0.12 }),
      },
    );

    invokeHandler(handlers, "turn_start", { turnIndex: 4 }, { sessionManager });
    const withinWindow = await invokeHandlerAsync<{
      message?: { content?: string };
      systemPrompt?: string;
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "within-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );
    expect(withinWindow.systemPrompt).toContain("[Brewva Context Contract]");
    expect(withinWindow.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(withinWindow.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");

    invokeHandler(handlers, "turn_start", { turnIndex: 5 }, { sessionManager });
    const afterWindow = await invokeHandlerAsync<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "after-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );
    expect(afterWindow.message?.content).toContain("[ContextCompactionGate]");
    expect(afterWindow.message?.content).toContain("[Context Status]");
    expect(afterWindow.message?.content).toContain("forced_compaction: yes");
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
  });

  test("keeps the gate disarmed when hydrated runtime state already reflects compaction", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextStatusThresholds(config, { hardRatio: 0.8 });
      }),
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-hydrate",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 7 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-hydrated-state",
          summary: "hydrated compact",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 300, contextWindow: 1000, percent: 0.3 }),
      },
    );
    invokeHandler(handlers, "turn_start", { turnIndex: 8 }, { sessionManager });

    const before = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "hydrated-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt).toContain("[Brewva Context Contract]");
    expect(before.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });
});
