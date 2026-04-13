import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildBrewvaTools,
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

  test("session_compact fails fast when the host reports compaction unsupported synchronously", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s11-unsupported";
    const tool = createSessionCompactTool({ runtime: createBundledToolRuntime(runtime) });

    const result = await tool.execute(
      "tc-compact-unsupported",
      { reason: "hosted runtime missing compaction" },
      undefined,
      undefined,
      mergeContext(sessionId, {
        compact: (options?: {
          customInstructions?: string;
          onError?: (error: unknown) => void;
        }) => {
          options?.onError?.(
            new Error(
              "Hosted compaction is not yet supported by the Brewva-native session runtime.",
            ),
          );
        },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("Session compaction request failed");
    expect(
      runtime.inspect.events.query(sessionId, { type: "session_compact_requested" }),
    ).toHaveLength(0);
    const failedEvent = runtime.inspect.events.query(sessionId, {
      type: "session_compact_failed",
      last: 1,
    })[0];
    expect(failedEvent?.payload).toEqual(
      expect.objectContaining({
        error: "Hosted compaction is not yet supported by the Brewva-native session runtime.",
      }),
    );
  });

  test("authority.session.commitCompaction records the durable compaction receipt and updates history-view baseline", () => {
    const runtime = createCleanRuntime();
    const sessionId = "s11-commit";

    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-42",
      sanitizedSummary: "[CompactSummary]\nKeep only the latest verification failures.",
      summaryDigest: "digest-42",
      sourceTurn: 1,
      leafEntryId: "leaf-42",
      referenceContextDigest: "prefix-42",
      fromTokens: 900,
      toTokens: 320,
      origin: "extension_api",
    });

    const compactEvent = runtime.inspect.events.query(sessionId, {
      type: "session_compact",
      last: 1,
    })[0];
    expect(compactEvent?.payload).toEqual(
      expect.objectContaining({
        compactId: "cmp-42",
        sanitizedSummary: "[CompactSummary]\nKeep only the latest verification failures.",
        summaryDigest: expect.any(String),
        sourceTurn: 1,
        leafEntryId: "leaf-42",
        referenceContextDigest: "prefix-42",
        fromTokens: 900,
        toTokens: 320,
        origin: "extension_api",
        integrityViolations: null,
      }),
    );
    expect(runtime.inspect.events.query(sessionId, { type: "context_compacted" })).toHaveLength(0);

    expect(runtime.inspect.context.getHistoryViewBaseline(sessionId)).toEqual(
      expect.objectContaining({
        compactId: "cmp-42",
        sanitizedSummary: "[CompactSummary]\nKeep only the latest verification failures.",
        summaryDigest: expect.any(String),
        leafEntryId: "leaf-42",
        referenceContextDigest: "prefix-42",
      }),
    );
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

  test("recall_search returns source-typed recall across prior sessions", async () => {
    const recallWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-recall-search-"));
    const runtime = new BrewvaRuntime({ cwd: recallWorkspace });
    const priorSessionId = "s12-recall-prior";
    const currentSessionId = "s12-recall-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix flaky worker bootstrap in the gateway runtime",
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: { id: "i-recall-1", text: "Stabilize flaky worker bootstrap", status: "todo" },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Investigate whether the flaky worker bootstrap issue already has precedent",
    });

    const tools = buildBrewvaTools({
      runtime: createBundledToolRuntime(runtime),
      toolNames: ["recall_search"],
    });
    const recallSearch = requireTool(tools, "recall_search");

    const result = await recallSearch.execute(
      "tc-recall-search",
      { query: "flaky worker bootstrap", limit: 5 },
      undefined,
      undefined,
      fakeContext(currentSessionId),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[RecallSearch]");
    expect(text).toContain("source_family=tape_evidence");
    expect(text).toContain(`session_id=${priorSessionId}`);

    const details = result.details as
      | {
          results?: Array<{
            sourceFamily?: string;
            sessionId?: string | null;
          }>;
        }
      | undefined;
    expect(details?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFamily: "tape_evidence",
          sessionId: priorSessionId,
        }),
      ]),
    );
  });

  test("recall_search can inspect stable ids and surface curation metadata", async () => {
    const recallWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-recall-inspect-"));
    const runtime = new BrewvaRuntime({ cwd: recallWorkspace });
    const priorSessionId = "s12-recall-inspect-prior";
    const currentSessionId = "s12-recall-inspect-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix flaky gateway bootstrap recall",
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: {
          id: "i-recall-inspect-1",
          text: "Fix flaky gateway bootstrap recall",
          status: "todo",
        },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Inspect prior recall state for the gateway bootstrap flake",
    });

    const tools = buildBrewvaTools({
      runtime: createBundledToolRuntime(runtime),
      toolNames: ["recall_search"],
    });
    const recallSearch = requireTool(tools, "recall_search");

    const initialResult = await recallSearch.execute(
      "tc-recall-inspect-search",
      { query: "gateway bootstrap recall", limit: 5 },
      undefined,
      undefined,
      fakeContext(currentSessionId),
    );
    const initialDetails = initialResult.details as
      | {
          results?: Array<{
            stableId?: string;
          }>;
        }
      | undefined;
    const stableId = (initialDetails?.results ?? [])
      .map((entry) => entry.stableId)
      .find((value): value is string => typeof value === "string" && value.startsWith("tape:"));
    expect(stableId).toBeDefined();

    recordRuntimeEvent(runtime, {
      sessionId: currentSessionId,
      type: "recall_curation_recorded",
      payload: {
        source: "recall_curate",
        signal: "helpful",
        stableIds: [stableId],
      } as Record<string, unknown>,
    });

    const inspectionResult = await recallSearch.execute(
      "tc-recall-inspect-stable-id",
      { stable_ids: [stableId] },
      undefined,
      undefined,
      fakeContext(currentSessionId),
    );
    const inspectionText = extractTextContent(inspectionResult);
    expect(inspectionText).toContain("mode: inspect");
    expect(inspectionText).toContain(`requested_stable_ids: ${stableId}`);
    expect(inspectionText).toContain("curation_adjustment=");

    const inspectionDetails = inspectionResult.details as
      | {
          mode?: string;
          unresolvedStableIds?: string[];
          results?: Array<{
            stableId?: string;
            curation?: {
              helpfulSignals?: number;
              scoreAdjustment?: number;
            } | null;
          }>;
        }
      | undefined;
    expect(inspectionDetails?.mode).toBe("inspect");
    expect(inspectionDetails?.unresolvedStableIds).toEqual([]);
    expect(inspectionDetails?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableId,
          curation: expect.objectContaining({
            helpfulSignals: 1,
          }),
        }),
      ]),
    );
    expect(inspectionDetails?.results?.[0]?.curation?.scoreAdjustment).toBeGreaterThan(0);
  });

  test("recall_search keeps user_repository_root scoped by default and only widens with workspace_wide", async () => {
    const recallWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-recall-scope-"));
    mkdirSync(join(recallWorkspace, "packages", "gateway"), { recursive: true });
    mkdirSync(join(recallWorkspace, "packages", "cli"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: recallWorkspace });
    const gatewaySessionId = "s12-recall-scope-gateway";
    const cliSessionId = "s12-recall-scope-cli";
    const currentSessionId = "s12-recall-scope-current";

    runtime.maintain.context.onTurnStart(gatewaySessionId, 1);
    runtime.authority.task.setSpec(gatewaySessionId, {
      schema: "brewva.task.v1",
      goal: "Fix bootstrap ordering in the gateway runtime",
      targets: {
        files: ["packages/gateway"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: gatewaySessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: { id: "gateway-bootstrap", text: "Fix gateway bootstrap ordering", status: "todo" },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(cliSessionId, 1);
    runtime.authority.task.setSpec(cliSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix bootstrap ordering in the cli runtime",
      targets: {
        files: ["packages/cli"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: cliSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: { id: "cli-bootstrap", text: "Fix cli bootstrap ordering", status: "todo" },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Check whether gateway bootstrap ordering already has prior work",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const tools = buildBrewvaTools({
      runtime: createBundledToolRuntime(runtime),
      toolNames: ["recall_search"],
    });
    const recallSearch = requireTool(tools, "recall_search");

    const defaultResult = await recallSearch.execute(
      "tc-recall-scope-default",
      { query: "bootstrap ordering", limit: 10 },
      undefined,
      undefined,
      fakeContext(currentSessionId),
    );
    const defaultDetails = defaultResult.details as
      | {
          results?: Array<{
            sessionId?: string | null;
          }>;
        }
      | undefined;
    const defaultSessionIds = new Set(
      (defaultDetails?.results ?? []).map((entry) => entry.sessionId).filter(Boolean),
    );
    expect(defaultSessionIds.has(gatewaySessionId)).toBe(true);
    expect(defaultSessionIds.has(cliSessionId)).toBe(false);

    const widenedResult = await recallSearch.execute(
      "tc-recall-scope-wide",
      { query: "bootstrap ordering", scope: "workspace_wide", limit: 10 },
      undefined,
      undefined,
      fakeContext(currentSessionId),
    );
    const widenedDetails = widenedResult.details as
      | {
          results?: Array<{
            sessionId?: string | null;
          }>;
        }
      | undefined;
    const widenedSessionIds = new Set(
      (widenedDetails?.results ?? []).map((entry) => entry.sessionId).filter(Boolean),
    );
    expect(widenedSessionIds.has(gatewaySessionId)).toBe(true);
    expect(widenedSessionIds.has(cliSessionId)).toBe(true);
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
