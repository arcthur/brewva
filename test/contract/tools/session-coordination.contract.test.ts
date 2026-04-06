import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  createReasoningCheckpointTool,
  createReasoningRevertTool,
  createSessionCompactTool,
  createTapeTools,
} from "@brewva/brewva-tools";
import { requireDefined } from "../../helpers/assertions.js";
import { createBundledToolRuntime, createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { extractTextContent, fakeContext, mergeContext } from "./tools-flow.helpers.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("session-coordination-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(cwd = workspace): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
}

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  return requireDefined(
    tools.find((tool) => tool.name === name),
    `Expected tool ${name}.`,
  );
}

describe("session coordination tool contracts", () => {
  test("session_compact requests SDK compaction with runtime instructions without sending a hidden follow-up", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s11";
    let compactCalls = 0;
    let capturedInstructions: string | undefined;
    let hiddenFollowUpCalls = 0;

    const tool = createSessionCompactTool({ runtime: createBundledToolRuntime(runtime) });
    const result = await tool.execute(
      "tc-compact",
      { reason: "context pressure reached high" },
      undefined,
      undefined,
      mergeContext(sessionId, {
        compact: (options?: {
          customInstructions?: string;
          onError?: (error: unknown) => void;
        }) => {
          compactCalls += 1;
          capturedInstructions = options?.customInstructions;
        },
        sendUserMessage: () => {
          hiddenFollowUpCalls += 1;
        },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("Session compaction requested");
    expect(compactCalls).toBe(1);
    expect(capturedInstructions).toBe(runtime.inspect.context.getCompactionInstructions());
    expect(hiddenFollowUpCalls).toBe(0);
    const requestedEvent = runtime.inspect.events.query(sessionId, {
      type: "session_compact_requested",
      last: 1,
    })[0];
    const payload = requestedEvent?.payload as { usagePercent?: number | null } | undefined;
    expect(payload?.usagePercent).toBe(0.9);
  });

  test("session_compact normalizes usagePercent even when runtime getUsageRatio is unavailable", async () => {
    const events: Array<{
      sessionId: string;
      type: string;
      payload?: Record<string, unknown>;
    }> = [];

    const tool = createSessionCompactTool({
      runtime: {
        inspect: {
          context: {
            getCompactionInstructions: () => "compact-now",
          },
        },
        internal: {
          recordEvent: (event: {
            sessionId: string;
            type: string;
            payload?: Record<string, unknown>;
          }) => {
            events.push({
              sessionId: event.sessionId,
              type: event.type,
              payload: event.payload,
            });
          },
        },
      } as any,
    });

    await tool.execute(
      "tc-compact-fallback",
      {},
      undefined,
      undefined,
      mergeContext("s11-fallback", {
        compact: () => undefined,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 95 }),
      }),
    );

    const requestedEvent = events.find((event) => event.type === "session_compact_requested");
    const payload = requestedEvent?.payload as { usagePercent?: number | null } | undefined;
    expect(payload?.usagePercent).toBe(0.95);
  });

  test("tape_handoff writes an anchor and tape_info reports tape and context pressure", async () => {
    const tapeInfoWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-info-"));
    const runtime = new BrewvaRuntime({ cwd: tapeInfoWorkspace });
    const sessionId = "s12";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "validate tape tools",
    });

    const tools = createTapeTools({ runtime });
    const tapeHandoff = requireTool(tools, "tape_handoff");
    const tapeInfo = requireTool(tools, "tape_info");

    const handoffResult = await tapeHandoff.execute(
      "tc-handoff",
      {
        name: "investigation-done",
        summary: "Findings captured.",
        next_steps: "Start implementation.",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const handoffText = extractTextContent(handoffResult);
    expect(handoffText).toContain("Tape handoff recorded");
    expect(runtime.inspect.events.query(sessionId, { type: "anchor" }).length).toBe(1);

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
        cacheHits: 3,
        cacheMisses: 1,
        blocked: false,
        matchLayers: { q1: "exact" },
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 0,
        throttleLevel: "limited",
        cacheHits: 1,
        cacheMisses: 2,
        blocked: false,
        matchLayers: { q2: "none" },
      } as Record<string, unknown>,
    });

    const infoResult = await tapeInfo.execute(
      "tc-info",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, {
        getContextUsage: () => ({ tokens: 880, contextWindow: 1000, percent: 0.88 }),
      }),
    );
    const infoText = extractTextContent(infoResult);
    expect(infoText).toContain("[TapeInfo]");
    expect(infoText).toContain("tape_pressure:");
    expect(infoText).toContain("context_pressure: high");
    expect(infoText).toContain("output_search_recent_calls: 2");
    expect(infoText).toContain("output_search_throttled_calls: 1");
    expect(infoText).toContain("output_search_cache_hit_rate: 57.1%");
    expect(infoText).toContain("output_search_match_layers: exact=1 partial=0 fuzzy=0 none=1");
  });

  test("tape_search returns matching entries in the current phase", async () => {
    const tapeSearchWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: tapeSearchWorkspace });
    const sessionId = "s12-search";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.events.recordTapeHandoff(sessionId, {
      name: "investigation",
      summary: "Collected flaky test evidence.",
      nextSteps: "Implement fix.",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: { id: "i1", text: "Fix flaky pipeline", status: "todo" },
      } as Record<string, unknown>,
    });

    const tools = createTapeTools({ runtime });
    const tapeSearch = requireTool(tools, "tape_search");

    const result = await tapeSearch.execute(
      "tc-search",
      { query: "flaky", scope: "current_phase" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[TapeSearch]");
    expect(text).toContain("matches:");
    expect(text.toLowerCase()).toContain("flaky");
  });

  test("reasoning_checkpoint records a durable checkpoint and tape_info reports the active branch", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s13-reasoning-checkpoint";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpointTool = createReasoningCheckpointTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const checkpointResult = await checkpointTool.execute(
      "tc-reasoning-checkpoint",
      { boundary: "operator_marker" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => "leaf-checkpoint-1",
        },
      } as any,
    );

    const checkpointText = extractTextContent(checkpointResult);
    expect(checkpointText).toContain("Recorded reasoning checkpoint reasoning-checkpoint-1");

    const state = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(state.activeBranchId).toBe(`${sessionId}:reasoning-branch-0`);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-1");
    expect(state.activeLineageCheckpointIds).toEqual(["reasoning-checkpoint-1"]);

    const tapeInfo = requireTool(createTapeTools({ runtime }), "tape_info");
    const infoResult = await tapeInfo.execute(
      "tc-reasoning-info",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const infoText = extractTextContent(infoResult);
    expect(infoText).toContain(`reasoning_active_branch: ${sessionId}:reasoning-branch-0`);
    expect(infoText).toContain("reasoning_active_checkpoint: reasoning-checkpoint-1");
    expect(infoText).toContain("reasoning_recent_checkpoints:");
    expect(infoText).toContain("revertable=yes");
  });

  test("reasoning_revert records a branch reset, aborts the active turn, and retires superseded checkpoints", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s14-reasoning-revert";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpointTool = createReasoningCheckpointTool({
      runtime: createBundledToolRuntime(runtime),
    });
    await checkpointTool.execute(
      "tc-reasoning-checkpoint-1",
      { boundary: "operator_marker" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => "leaf-before-1",
        },
      } as any,
    );
    await checkpointTool.execute(
      "tc-reasoning-checkpoint-2",
      { boundary: "tool_boundary" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => "leaf-before-2",
        },
      } as any,
    );

    let aborted = 0;
    const revertTool = createReasoningRevertTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const revertResult = await revertTool.execute(
      "tc-reasoning-revert",
      {
        checkpoint_id: "reasoning-checkpoint-1",
        continuity: "Resume from the earlier validated checkpoint only.",
        linked_rollback_receipt_ids: ["rollback-1", "rollback-1", "rollback-2"],
      },
      undefined,
      undefined,
      {
        abort: () => {
          aborted += 1;
        },
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as any,
    );

    const revertText = extractTextContent(revertResult);
    expect(revertText).toContain("Reasoning revert scheduled to reasoning-checkpoint-1");
    expect(aborted).toBe(1);

    const state = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(state.activeBranchId).toBe(`${sessionId}:reasoning-branch-1`);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-1");
    expect(state.activeLineageCheckpointIds).toEqual(["reasoning-checkpoint-1"]);
    expect(state.latestRevert).toMatchObject({
      toCheckpointId: "reasoning-checkpoint-1",
      fromCheckpointId: "reasoning-checkpoint-2",
      newBranchId: `${sessionId}:reasoning-branch-1`,
      linkedRollbackReceiptIds: ["rollback-1", "rollback-2"],
    });
    expect(state.latestContinuityPacket?.text).toBe(
      "Resume from the earlier validated checkpoint only.",
    );
    expect(runtime.inspect.reasoning.canRevertTo(sessionId, "reasoning-checkpoint-1")).toBe(true);
    expect(runtime.inspect.reasoning.canRevertTo(sessionId, "reasoning-checkpoint-2")).toBe(false);

    const tapeInfo = requireTool(createTapeTools({ runtime }), "tape_info");
    const infoResult = await tapeInfo.execute(
      "tc-reasoning-revert-info",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const infoText = extractTextContent(infoResult);
    expect(infoText).toContain("reasoning_recent_reverts:");
    expect(infoText).toContain(
      `- reasoning-revert-1 to=reasoning-checkpoint-1 from=reasoning-checkpoint-2 trigger=operator_request branch=${sessionId}:reasoning-branch-1`,
    );
  });

  test("reasoning_revert rejects continuity text that exceeds the byte cap without aborting the turn", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s15-reasoning-revert-cap";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpointTool = createReasoningCheckpointTool({
      runtime: createBundledToolRuntime(runtime),
    });
    await checkpointTool.execute(
      "tc-reasoning-cap-checkpoint",
      { boundary: "operator_marker" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => "leaf-cap-1",
        },
      } as any,
    );

    let aborted = 0;
    const revertTool = createReasoningRevertTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const oversizedContinuity = `${"\u00e9".repeat(600)}a`;
    const revertResult = await revertTool.execute(
      "tc-reasoning-revert-cap",
      {
        checkpoint_id: "reasoning-checkpoint-1",
        continuity: oversizedContinuity,
      },
      undefined,
      undefined,
      {
        abort: () => {
          aborted += 1;
        },
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as any,
    );

    const revertText = extractTextContent(revertResult);
    expect(revertText).toContain("Reasoning revert failed");
    expect(revertText).toContain("reasoning continuity exceeds 1200 bytes");
    expect((revertResult.details as { verdict?: unknown } | undefined)?.verdict).toBe("fail");
    expect(aborted).toBe(0);
    expect(runtime.inspect.reasoning.listReverts(sessionId)).toEqual([]);
    expect(runtime.inspect.reasoning.getActiveState(sessionId).activeCheckpointId).toBe(
      "reasoning-checkpoint-1",
    );
  });

  test("reasoning_revert rejects unknown checkpoints when the session has no reasoning checkpoints", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s16-reasoning-revert-missing-checkpoint";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    let aborted = 0;
    const revertTool = createReasoningRevertTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const revertResult = await revertTool.execute(
      "tc-reasoning-revert-missing",
      {
        checkpoint_id: "reasoning-checkpoint-1",
        continuity: "Resume from a checkpoint that does not exist.",
      },
      undefined,
      undefined,
      {
        abort: () => {
          aborted += 1;
        },
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as any,
    );

    const revertText = extractTextContent(revertResult);
    expect(revertText).toContain("Reasoning revert failed");
    expect(revertText).toContain("unknown reasoning checkpoint");
    expect((revertResult.details as { verdict?: unknown } | undefined)?.verdict).toBe("fail");
    expect(aborted).toBe(0);
    expect(runtime.inspect.reasoning.listReverts(sessionId)).toEqual([]);
    expect(runtime.inspect.reasoning.getActiveState(sessionId).activeCheckpointId).toBeNull();
  });
});
