import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import { listRuntimeExtensionOwnerIds } from "@brewva/brewva-runtime/runtime-extensions";
import { CAPABILITY_STATE_INLINE_DATA_MAX_BYTES } from "@brewva/brewva-runtime/session";
import type { ContextAdmission } from "@brewva/brewva-runtime/session";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createRuntime(name: string): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: createTestWorkspace(`session-lineage-${name}`),
    config: createOpsRuntimeConfig(),
  });
}

function recordMessageSource(runtime: BrewvaRuntime, sessionId: string, content: string): string {
  const event = createHostedRuntimePort(runtime).extensions.hosted.events.record({
    sessionId,
    type: "message_end",
    payload: {
      role: "user",
      content,
    },
  });
  if (!event) {
    throw new Error("failed to record test source event");
  }
  return event.id;
}

describe("session lineage runtime surface", () => {
  test("exposes lineage authority and inspect methods under session only", () => {
    const runtime = createRuntime("surface");

    expect(runtime.authority.session.lineage.createNode).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.recordContextEntry).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.recordSummary).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.recordOutcome).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.recordSelection).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.adoptOutcome).toBeTypeOf("function");
    expect(runtime.authority.session.lineage.recordCapabilityState).toBeTypeOf("function");
    expect(runtime.inspect.session.lineage.getTree).toBeTypeOf("function");
    expect(runtime.inspect.session.lineage.getNode).toBeTypeOf("function");
    expect(runtime.inspect.session.lineage.listChildren).toBeTypeOf("function");
    expect(runtime.inspect.session.lineage.getContextEntryPath).toBeTypeOf("function");
    expect((runtime.authority as unknown as Record<string, unknown>)["lineage"]).toBeUndefined();
    expect((runtime.inspect as unknown as Record<string, unknown>)["lineage"]).toBeUndefined();
  });

  test("records and replays a branch tree without a global active leaf", () => {
    const runtime = createRuntime("tree");
    const sessionId = "lineage-tree";

    const main = runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: {
        kind: "session_root",
      },
      title: "Main task",
    });
    const mainSourceEventId = recordMessageSource(runtime, sessionId, "main message");
    runtime.authority.session.lineage.recordContextEntry(sessionId, {
      entryId: "ctx-main-1",
      lineageNodeId: "ln-main",
      parentEntryId: null,
      sourceEventId: mainSourceEventId,
      sourceEventType: "message_end",
      entryKind: "message",
      admission: "context_required",
      presentTo: "both",
    });
    const review = runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-review",
      parentLineageNodeId: "ln-main",
      kind: "review",
      forkPoint: {
        kind: "context_entry",
        lineageNodeId: "ln-main",
        entryId: "ctx-main-1",
      },
    });
    const reviewSourceEventId = recordMessageSource(runtime, sessionId, "review message");
    runtime.authority.session.lineage.recordContextEntry(sessionId, {
      entryId: "ctx-review-1",
      lineageNodeId: "ln-review",
      parentEntryId: "ctx-main-1",
      sourceEventId: reviewSourceEventId,
      sourceEventType: "message_end",
      entryKind: "message",
      admission: "context_required",
      presentTo: "llm",
    });

    expect(main.type).toBe(SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE);
    expect(review.type).toBe(SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE);
    expect(runtime.inspect.session.lineage.listChildren(sessionId, "ln-main")).toEqual([
      expect.objectContaining({
        lineageNodeId: "ln-review",
        parentLineageNodeId: "ln-main",
        kind: "review",
      }),
    ]);
    expect(runtime.inspect.session.lineage.getTree(sessionId)).toEqual(
      expect.objectContaining({
        sessionId,
        rootNodeId: "ln-main",
        nodes: expect.arrayContaining([
          expect.objectContaining({ lineageNodeId: "ln-main", kind: "main" }),
          expect.objectContaining({ lineageNodeId: "ln-review", kind: "review" }),
        ]),
        edges: [
          {
            parentLineageNodeId: "ln-main",
            childLineageNodeId: "ln-review",
          },
        ],
      }),
    );
    expect(
      runtime.inspect.session.lineage
        .getContextEntryPath(sessionId, {
          lineageNodeId: "ln-review",
          entryId: "ctx-review-1",
        })
        .map((entry) => entry.entryId),
    ).toEqual(["ctx-main-1", "ctx-review-1"]);
    expect(
      runtime.inspect.session.lineage
        .getContextEntryPath(sessionId, {
          lineageNodeId: "ln-main",
          entryId: "ctx-main-1",
        })
        .map((entry) => entry.entryId),
    ).toEqual(["ctx-main-1"]);
  });

  test("keeps child outcomes state-only until explicit adoption promotes them", () => {
    const runtime = createRuntime("adoption");
    const sessionId = "lineage-adoption";

    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });
    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-worker",
      parentLineageNodeId: "ln-main",
      kind: "subagent",
      forkPoint: { kind: "worker_run", workerRunId: "worker-1" },
    });
    const outcome = runtime.authority.session.lineage.recordOutcome(sessionId, {
      outcomeId: "outcome-worker-1",
      lineageNodeId: "ln-worker",
      summary: "Worker found the smaller patch.",
      outcomeRef: "artifact://worker-1/outcome.json",
    });

    expect(outcome.type).toBe(SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE);
    expect(outcome.payload).toMatchObject({
      admission: "state_only" satisfies ContextAdmission,
    });

    const adopted = runtime.authority.session.lineage.adoptOutcome(sessionId, {
      adoptionId: "adopt-worker-1",
      outcomeId: "outcome-worker-1",
      fromLineageNodeId: "ln-worker",
      toLineageNodeId: "ln-main",
      admission: "context_required",
      summary: "Adopt the worker's smaller patch.",
    });

    expect(adopted.type).toBe(SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE);
    expect(runtime.inspect.session.lineage.getNode(sessionId, "ln-worker")).toEqual(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            outcomeId: "outcome-worker-1",
            admission: "state_only",
          }),
        ],
      }),
    );
    expect(runtime.inspect.session.lineage.getNode(sessionId, "ln-main")).toEqual(
      expect.objectContaining({
        adoptedOutcomes: [
          expect.objectContaining({
            outcomeId: "outcome-worker-1",
            admission: "context_required",
          }),
        ],
      }),
    );
    expect(() =>
      runtime.authority.session.lineage.recordOutcome(sessionId, {
        outcomeId: "outcome-worker-1",
        lineageNodeId: "ln-worker",
        summary: "Duplicate outcome should be rejected.",
      }),
    ).toThrow("session_lineage_outcome_exists");
    expect(() =>
      runtime.authority.session.lineage.recordOutcome(sessionId, {
        outcomeId: "outcome-worker-required",
        lineageNodeId: "ln-worker",
        summary: "Direct context-required outcome should be rejected.",
        admission: "context_required" as never,
      }),
    ).toThrow("session_lineage_outcome_requires_adoption");
    expect(() =>
      runtime.authority.session.lineage.adoptOutcome(sessionId, {
        adoptionId: "adopt-worker-1",
        outcomeId: "outcome-worker-1",
        fromLineageNodeId: "ln-worker",
        toLineageNodeId: "ln-main",
        admission: "context_required",
      }),
    ).toThrow("session_lineage_outcome_adoption_exists");
    expect(() =>
      runtime.authority.session.lineage.adoptOutcome(sessionId, {
        adoptionId: "adopt-worker-2",
        outcomeId: "outcome-worker-1",
        fromLineageNodeId: "ln-main",
        toLineageNodeId: "ln-worker",
        admission: "context_required",
      }),
    ).toThrow("session_lineage_outcome_lineage_mismatch");
  });

  test("records channel-local lineage selection through the authority surface", () => {
    const runtime = createRuntime("selection");
    const sessionId = "lineage-selection";

    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });
    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-review",
      parentLineageNodeId: "ln-main",
      kind: "review",
      forkPoint: { kind: "turn", turnId: "turn-review" },
    });
    runtime.authority.session.lineage.recordSelection(sessionId, {
      selectionId: "selection-tui-1",
      channelId: "tui",
      lineageNodeId: "ln-review",
      previousLineageNodeId: "ln-main",
      reason: "operator-navigation",
    });

    expect(runtime.inspect.session.lineage.getTree(sessionId).selectedByChannel).toEqual({
      tui: "ln-review",
    });
    expect(() =>
      runtime.authority.session.lineage.recordSelection(sessionId, {
        selectionId: "selection-tui-2",
        channelId: "tui",
        lineageNodeId: "ln-missing",
      }),
    ).toThrow("session_lineage_node_missing");
  });

  test("fails closed for undeclared capability state owners and oversized inline state", () => {
    const runtime = createRuntime("capability-state");
    const sessionId = "lineage-capability-state";

    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });
    const ownerCapability = `brewva.skill.${runtime.inspect.skills.catalog.list()[0]?.name ?? "review"}`;
    const state = runtime.authority.session.lineage.recordCapabilityState(sessionId, {
      stateId: "state-review-1",
      ownerCapability,
      customType: "review-cache",
      data: {
        latestFindingCount: 2,
      },
      artifactRef: "artifact://review/state.json",
      lineageNodeId: "ln-main",
    });

    expect(state.payload).toMatchObject({
      ownerCapability,
      artifactRef: "artifact://review/state.json",
    });
    expect(() =>
      runtime.authority.session.lineage.recordCapabilityState(sessionId, {
        stateId: "state-unknown",
        ownerCapability: "foo.bar.baz",
        customType: "unknown-cache",
        data: {},
      }),
    ).toThrow("capability_state_owner_undeclared:foo.bar.baz");
    expect(() =>
      runtime.authority.session.lineage.recordCapabilityState(sessionId, {
        stateId: "state-too-large",
        ownerCapability,
        customType: "review-cache",
        data: {
          text: "x".repeat(CAPABILITY_STATE_INLINE_DATA_MAX_BYTES + 1),
        },
      }),
    ).toThrow("capability_state_inline_payload_too_large:state-too-large");
  });

  test("declares capability state owners without exposing runtime extension capability tokens", () => {
    const runtime = createRuntime("runtime-extension-capabilities");
    const sessionId = "lineage-runtime-extension-capabilities";
    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });

    const ownerIds = listRuntimeExtensionOwnerIds();
    expect(ownerIds.length).toBeGreaterThan(0);
    expect(
      "capabilities" in
        (createHostedRuntimePort(runtime).extensions.hosted.events as unknown as object),
    ).toBe(false);
    for (const [index, ownerCapability] of ownerIds.entries()) {
      expect(() =>
        runtime.authority.session.lineage.recordCapabilityState(sessionId, {
          stateId: `state-extension-${index}`,
          ownerCapability,
          customType: "extension-cache",
          data: { index },
          lineageNodeId: "ln-main",
        }),
      ).not.toThrow();
    }
  });

  test("rejects lineage inspection for tapes without an explicit root", () => {
    const runtime = createRuntime("missing-root");
    const sessionId = "lineage-missing-root";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "message_end",
      payload: {
        role: "user",
        content: "old tape without lineage root",
      },
    });

    expect(() => runtime.inspect.session.lineage.getTree(sessionId)).toThrow(
      "session_lineage_root_missing",
    );
  });

  test("records summaries as admitted lineage context without mutating topology", () => {
    const runtime = createRuntime("summary");
    const sessionId = "lineage-summary";

    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });
    const sourceEventId = recordMessageSource(runtime, sessionId, "summary attachment");
    runtime.authority.session.lineage.recordContextEntry(sessionId, {
      entryId: "ctx-main-1",
      lineageNodeId: "ln-main",
      parentEntryId: null,
      sourceEventId,
      sourceEventType: "message_end",
      entryKind: "message",
      admission: "context_required",
      presentTo: "both",
    });
    const summary = runtime.authority.session.lineage.recordSummary(sessionId, {
      summaryId: "summary-review",
      lineageNodeId: "ln-main",
      attachToEntryId: "ctx-main-1",
      summary: "Review branch found no blocking issues.",
      admission: "context_eligible",
    });

    expect(summary.type).toBe(SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE);
    expect(runtime.inspect.session.lineage.getTree(sessionId).edges).toEqual([]);
    expect(runtime.inspect.session.lineage.getNode(sessionId, "ln-main")).toEqual(
      expect.objectContaining({
        summaries: [
          expect.objectContaining({
            summaryId: "summary-review",
            admission: "context_eligible",
          }),
        ],
      }),
    );
  });

  test("records context-entry linker events instead of adding ancestry to source events", () => {
    const runtime = createRuntime("linker");
    const sessionId = "lineage-linker";

    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "ln-main",
      kind: "main",
      forkPoint: { kind: "session_root" },
    });
    expect(() =>
      runtime.authority.session.lineage.recordContextEntry(sessionId, {
        entryId: "ctx-missing-source",
        lineageNodeId: "ln-main",
        parentEntryId: null,
        sourceEventId: "missing-source-event",
        sourceEventType: "message_end",
        entryKind: "message",
        admission: "context_required",
        presentTo: "both",
      }),
    ).toThrow("session_context_entry_source_missing");
    const source = createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "message_end",
      payload: {
        role: "assistant",
        content: "Source message stays stable.",
      },
    });
    expect(() =>
      runtime.authority.session.lineage.recordContextEntry(sessionId, {
        entryId: "ctx-source-type-mismatch",
        lineageNodeId: "ln-main",
        parentEntryId: null,
        sourceEventId: source?.id ?? "missing",
        sourceEventType: "tool_result_recorded",
        entryKind: "message",
        admission: "context_required",
        presentTo: "both",
      }),
    ).toThrow("session_context_entry_source_type_mismatch");
    const linker = runtime.authority.session.lineage.recordContextEntry(sessionId, {
      entryId: "ctx-assistant-1",
      lineageNodeId: "ln-main",
      parentEntryId: null,
      sourceEventId: source?.id ?? "missing",
      sourceEventType: "message_end",
      entryKind: "message",
      admission: "context_required",
      presentTo: "both",
    });

    expect(linker.type).toBe(CONTEXT_ENTRY_RECORDED_EVENT_TYPE);
    expect(
      runtime.inspect.events.records.query(sessionId, { type: "message_end" })[0]?.payload,
    ).not.toHaveProperty("parentEntryId");
    expect(
      runtime.inspect.events.records.query(sessionId, { type: CONTEXT_ENTRY_RECORDED_EVENT_TYPE }),
    ).toHaveLength(1);
  });
});
