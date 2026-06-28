import { describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-vocabulary/delegation";
import { TASK_ITEM_ADDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("hosted runtime event query", () => {
  test("uses canonical tape window semantics for derived event views", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-window"),
    });

    for (let index = 0; index < 5; index += 1) {
      runtime.ops.task.items.add("query-window-session", {
        id: `item-${index}`,
        text: `item ${index}`,
        timestamp: 1_000 + index,
      });
    }

    expect(
      runtime.ops.events.records
        .query("query-window-session", {
          type: TASK_ITEM_ADDED_EVENT_TYPE,
          last: 3,
          offset: 1,
          limit: 1,
        })
        .map((event) => event.payload?.id),
    ).toEqual(["item-3"]);
  });

  test("replays the latest skill selection receipt from durable events", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-skill-selection"),
    });
    const sessionId = "skill-selection-replay";

    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "skill_selection_old",
      explicitSkillMentions: [],
      selectionMode: "none",
    });
    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "skill_selection_new",
      explicitSkillMentions: [{ name: "code-review" }],
      selectionMode: "shortlist_prompt_context",
    });

    expect(runtime.ops.skills.selection.latest(sessionId)).toMatchObject({
      selectionId: "skill_selection_new",
      explicitSkillMentions: [{ name: "code-review" }],
      selectionMode: "shortlist_prompt_context",
    });
  });

  test("replays the latest capability selection receipt from durable events", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-capability-selection"),
    });
    const sessionId = "capability-selection-replay";

    runtime.ops.tools.capabilitySelection.record(sessionId, {
      selection_id: "capability_selection_old",
      selected_capabilities: [{ name: "github-readonly" }],
      registry_version: "registry-v1",
    });
    runtime.ops.tools.capabilitySelection.record(sessionId, {
      selection_id: "capability_selection_new",
      selected_capabilities: [{ name: "github-write" }],
      registry_version: "registry-v2",
    });

    expect(runtime.ops.tools.capabilitySelection.latest(sessionId)).toMatchObject({
      selection_id: "capability_selection_new",
      selected_capabilities: [{ name: "github-write" }],
      registry_version: "registry-v2",
    });
  });

  test("rebuilds assistant cost summary from durable runtime ops events", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-cost-summary"),
    });
    const sessionId = "cost-summary-replay";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 37,
      costUsd: 0.12,
    });
    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "anthropic/claude",
      input: 3,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      totalTokens: 10,
      cost: { total: 0.05 },
    });

    const summary = runtime.ops.cost.summary.get(sessionId);

    expect(summary).toMatchObject({
      inputTokens: 13,
      outputTokens: 24,
      cacheReadTokens: 6,
      cacheWriteTokens: 4,
      totalTokens: 47,
    });
    expect(summary.totalCostUsd).toBeCloseTo(0.17);
    expect(summary.models["openai/gpt-5"]).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 37,
      totalCostUsd: 0.12,
    });
    expect(summary.models["anthropic/claude"]).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      totalTokens: 10,
      totalCostUsd: 0.05,
    });
  });

  test("rebuilds pending approval requests and request-local decisions from durable tape", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-approval-requests"),
    });
    const sessionId = "approval-request-replay";

    const decision = await runtime.runtime.kernel.beginToolCall({
      sessionId,
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });

    expect(decision).toMatchObject({
      kind: "defer",
      request: {
        id: "approval:approval-request-replay:call-exec",
      },
    });
    expect(runtime.ops.proposals.requests.listPending(sessionId)).toMatchObject([
      {
        requestId: "approval:approval-request-replay:call-exec",
        id: "approval:approval-request-replay:call-exec",
        proposalId: "tool:approval-request-replay:call-exec",
        state: "pending",
        subject: "exec",
        toolName: "exec",
        toolCallId: "call-exec",
        boundary: "effectful",
        effects: ["local_exec"],
        argsSummary: "command=echo hello",
        argsDigest: expect.stringMatching(/^stable-json-sha256\/v1:[0-9a-f]{64}$/u),
      },
    ]);

    expect(
      runtime.ops.proposals.requests.decide(
        sessionId,
        "approval:approval-request-replay:call-exec",
        {
          decision: "deny",
          actor: "arthur",
          reason: "not now",
        },
      ),
    ).toEqual({
      requestId: "approval:approval-request-replay:call-exec",
      decision: "deny",
      applied: true,
    });

    expect(runtime.ops.proposals.requests.listPending(sessionId)).toEqual([]);
    expect(runtime.ops.proposals.requests.list(sessionId)).toMatchObject([
      {
        requestId: "approval:approval-request-replay:call-exec",
        state: "denied",
        actor: "arthur",
        reason: "not now",
      },
    ]);
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "pending" })).toEqual([]);
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "denied" })).toMatchObject([
      {
        requestId: "approval:approval-request-replay:call-exec",
        state: "denied",
      },
    ]);
    expect(
      runtime.ops.proposals.requests.decide(
        sessionId,
        "approval:approval-request-replay:call-exec",
        {
          decision: "accept",
          actor: "arthur",
        },
      ),
    ).toEqual({
      requestId: "approval:approval-request-replay:call-exec",
      decision: "accept",
      applied: false,
      alreadyDecidedState: "denied",
    });
    // The late attempt left a durable no-op receipt without changing authority.
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "denied" })).toMatchObject([
      {
        requestId: "approval:approval-request-replay:call-exec",
        state: "denied",
      },
    ]);
  });

  test("rebuilds turn-scoped approval request rows from durable tape", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-approval-turn-id"),
    });
    const sessionId = "approval-request-turn-id";

    await runtime.runtime.kernel.beginToolCall({
      sessionId,
      turnId: "turn-approval",
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });

    expect(runtime.ops.proposals.requests.listPending(sessionId)).toMatchObject([
      {
        requestId: "approval:approval-request-turn-id:turn-approval:call-exec",
        proposalId: "tool:approval-request-turn-id:turn-approval:call-exec",
        turnId: "turn-approval",
      },
    ]);
  });

  test("advisory runtime ops events never bear approval authority", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-advisory-powerless"),
    });
    const sessionId = "approval-advisory-powerless";
    const requestId = "approval:approval-advisory-powerless:turn-approval:call-exec";

    await runtime.runtime.kernel.beginToolCall({
      sessionId,
      turnId: "turn-approval",
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });
    // An advisory event that mimics a decision must change nothing: approval
    // authority enters the tape only through the kernel's decision writer.
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      turnId: "turn-approval",
      namespace: "runtime.ops",
      kind: "approval.decided",
      version: 1,
      payload: {
        id: requestId,
        requestId,
        decision: "accept",
        actor: "impostor",
      },
    });
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "accepted" })).toEqual([]);
    expect(runtime.ops.proposals.requests.listPending(sessionId)).toMatchObject([
      { requestId, state: "pending" },
    ]);

    // The canonical writer is the only path that binds.
    const receipt = runtime.runtime.kernel.recordApprovalDecision({
      sessionId,
      requestId,
      decision: "accept",
      actor: "arthur",
    });
    expect(receipt).toMatchObject({ requestId, decision: "accept", applied: true });
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "accepted" })).toMatchObject([
      {
        requestId,
        proposalId: "tool:approval-advisory-powerless:turn-approval:call-exec",
        state: "accepted",
        turnId: "turn-approval",
        actor: "arthur",
      },
    ]);
  });

  test("open approval requests past their closure bound project as expired", async () => {
    // Injected projection clock keeps this deterministic under load: no real
    // time needs to pass for the display-time expiry projection to flip.
    let projectionNow = Date.now();
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-expired-projection"),
      clock: () => projectionNow,
    });
    const sessionId = "approval-expired-projection";
    const expiresAt = projectionNow + 3_600_000;

    const decision = await runtime.runtime.kernel.beginToolCall({
      sessionId,
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
      approval: { required: true, reason: "requires_operator_approval", expiresAt },
    });
    expect(decision).toMatchObject({ kind: "defer" });
    expect(runtime.ops.proposals.requests.list(sessionId)).toMatchObject([
      { state: "pending", expiresAt },
    ]);

    projectionNow = expiresAt;
    expect(runtime.ops.proposals.requests.list(sessionId)).toMatchObject([
      { state: "expired", expiresAt },
    ]);
    expect(runtime.ops.proposals.requests.listPending(sessionId)).toEqual([]);
  });

  test("denied approval-bound commitments cannot commit results", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-denied-not-committable"),
    });
    const sessionId = "approval-denied-not-committable";

    const decision = await runtime.runtime.kernel.beginToolCall({
      sessionId,
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });
    expect(decision).toMatchObject({
      kind: "defer",
      commitmentId: "tool:approval-denied-not-committable:call-exec",
    });
    runtime.ops.proposals.requests.decide(
      sessionId,
      "approval:approval-denied-not-committable:call-exec",
      {
        decision: "deny",
        actor: "arthur",
      },
    );
    expect(
      runtime.runtime.kernel.commitToolResult({
        commitmentId: "tool:approval-denied-not-committable:call-exec",
        result: { outcome: { kind: "ok", value: {} }, content: "unexpected commit" },
      }),
    ).rejects.toThrow(
      "tool_commitment_approval_request_denied:tool:approval-denied-not-committable:call-exec",
    );

    expect(runtime.ops.proposals.requests.list(sessionId)).toMatchObject([
      {
        requestId: "approval:approval-denied-not-committable:call-exec",
        state: "denied",
      },
    ]);
    const aborted = runtime.runtime.tape.list(sessionId, { type: "tool.aborted" });
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({
      commitmentId: "tool:approval-denied-not-committable:call-exec",
      reason: "approval_request_denied",
    });
  });

  test("an accepted approval whose commitment aborts closes as cancelled, not consumed", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-accepted-abort-cancelled"),
    });
    const sessionId = "approval-accepted-abort-cancelled";

    await runtime.runtime.kernel.beginToolCall({
      sessionId,
      turnId: "turn-approval",
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });
    runtime.ops.proposals.requests.decide(
      sessionId,
      "approval:approval-accepted-abort-cancelled:turn-approval:call-exec",
      {
        decision: "accept",
        actor: "arthur",
      },
    );
    await runtime.runtime.kernel.abortToolCall({
      commitmentId: "tool:approval-accepted-abort-cancelled:turn-approval:call-exec",
      reason: "tool_execution_failed",
    });

    // Consumed is reserved for closures that produced a durable committed
    // result; an aborted closure ends as cancelled with the abort reason.
    expect(runtime.ops.proposals.requests.list(sessionId)).toMatchObject([
      {
        requestId: "approval:approval-accepted-abort-cancelled:turn-approval:call-exec",
        state: "cancelled",
        reason: "tool_execution_failed",
      },
    ]);
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "accepted" })).toEqual([]);
    expect(runtime.ops.proposals.requests.list(sessionId, { state: "consumed" })).toEqual([]);
  });

  test("rebuilds subagent activity records from durable lifecycle events", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-subagent-replay"),
    });
    const sessionId = "subagent-replay";
    const runPayload = {
      contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
      runId: "run-display-replay",
      agent: "navigator",
      targetName: "navigator",
      delegate: "navigator",
      taskName: "inspect-display-replay",
      taskPath: "/inspect-display-replay",
      nickname: "Inspect display replay",
      depth: 1,
      forkTurns: "none",
      gateReason: "find_evidence",
      modelCategory: "read-only",
      executionPrimitive: "named",
      visibility: "public",
      isolationStrategy: "shared",
      adoption: {
        contractId: "subagent-replay-test",
        decision: "context_required",
        reason: "Replay must preserve parent-visible activity.",
      },
      createdAt: 1_000,
      updatedAt: 1_000,
      label: "Inspect display replay",
      kind: "evidence",
    };

    runtime.ops.delegation.lifecycle.spawned({
      sessionId,
      timestamp: 1_000,
      payload: { ...runPayload, status: "pending" },
    });
    runtime.ops.delegation.lifecycle.running({
      sessionId,
      timestamp: 1_100,
      payload: {
        ...runPayload,
        status: "running",
        updatedAt: 1_100,
        childSessionId: "worker-display-replay",
      },
    });
    runtime.ops.delegation.lifecycle.completed({
      sessionId,
      timestamp: 1_200,
      payload: {
        ...runPayload,
        status: "completed",
        updatedAt: 1_200,
        childSessionId: "worker-display-replay",
        summary: "Subagent found the replay projection path.",
        resultData: { kind: "evidence", summary: "Replay projection is durable." },
      },
    });

    const store = new HostedDelegationStore(runtime);
    const runs = await store.listRunsFromReadModel(sessionId, { includeTerminal: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "run-display-replay",
      status: "completed",
      label: "Inspect display replay",
      workerSessionId: "worker-display-replay",
      summary: "Subagent found the replay projection path.",
      resultData: { kind: "evidence", summary: "Replay projection is durable." },
    });
  });

  test("replays runtime turn assistant text and tool outputs through session wire", async () => {
    let providerCalls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 2) {
          yield { type: "text", delta: "Architecture docs live under docs/architecture." };
          return;
        }
        yield { type: "text", delta: "Let me search first." };
        yield {
          type: "tool",
          call: {
            toolCallId: "call-grep-1",
            toolName: "grep",
            args: { query: "architecture" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute() {
        return {
          outcome: { kind: "ok", value: {} },
          content: [{ type: "text", text: "docs/architecture/system-architecture.md" }],
        };
      },
    };
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-session-wire"),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });
    const sessionId = "session-wire-runtime-turn";

    await Array.fromAsync(
      runtime.runtime.turn({
        sessionId,
        prompt: "show architecture docs",
      }),
    );

    const committed = runtime.ops.sessionWire
      .query(sessionId)
      .find((frame) => frame.type === "turn.committed");

    expect(committed).toMatchObject({
      type: "turn.committed",
      turnId: expect.stringMatching(/^turn_/u),
      assistantText: "Let me search first.Architecture docs live under docs/architecture.",
      assistantSegments: [
        {
          text: "Let me search first.",
          ts: expect.any(Number),
          sourceEventId: expect.any(String),
        },
        {
          text: "Architecture docs live under docs/architecture.",
          ts: expect.any(Number),
          sourceEventId: expect.any(String),
        },
      ],
      toolOutputs: [
        {
          toolCallId: "call-grep-1",
          toolName: "grep",
          verdict: "pass",
          isError: false,
          text: "docs/architecture/system-architecture.md",
          ts: expect.any(Number),
          sourceEventId: expect.any(String),
        },
      ],
    });
  });

  test("emits live session wire frames to active subscribers", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-session-wire-subscribe"),
    });
    const frames: unknown[] = [];
    const unsubscribe = runtime.ops.sessionWire.subscribe("session-wire-live", (frame) => {
      frames.push(frame);
    });

    runtime.ops.session.lifecycle.shutdown("session-wire-live", { reason: "test_shutdown" });

    expect(frames).toMatchObject([
      {
        type: "session.closed",
        sessionId: "session-wire-live",
        reason: "test_shutdown",
      },
    ]);
    expect(unsubscribe()).toBe(true);
  });
});
