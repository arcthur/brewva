import { describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-vocabulary/delegation";
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
          type: "task.item.added",
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
          ok: true,
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
