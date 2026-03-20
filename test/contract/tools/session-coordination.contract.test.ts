import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSessionCompactTool, createTapeTools } from "@brewva/brewva-tools";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { extractTextContent, fakeContext, mergeContext } from "./tools-flow.helpers.js";

function createCleanRuntime(cwd = process.cwd()): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
}

describe("session coordination tool contracts", () => {
  test("session_compact requests SDK compaction with runtime instructions without sending a hidden follow-up", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s11";
    let compactCalls = 0;
    let capturedInstructions: string | undefined;
    let hiddenFollowUpCalls = 0;

    const tool = createSessionCompactTool({ runtime });
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
    expect(capturedInstructions).toBe(runtime.context.getCompactionInstructions());
    expect(hiddenFollowUpCalls).toBe(0);
    const requestedEvent = runtime.events.query(sessionId, {
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
        context: {
          getCompactionInstructions: () => "compact-now",
          getUsage: () => undefined,
          getPressureStatus: () => ({
            level: "high",
            usageRatio: 0.95,
            hardLimitRatio: 0.97,
            compactionThresholdRatio: 0.9,
          }),
        },
        events: {
          list: () => [],
          getTapeStatus: () => ({
            totalEntries: 0,
            entriesSinceAnchor: 0,
            entriesSinceCheckpoint: 0,
            tapePressure: "low",
            thresholds: { low: 10, medium: 20, high: 30 },
            lastAnchor: null,
            lastCheckpointId: null,
            outputSearch: null,
          }),
          recordTapeHandoff: () => ({ ok: false, error: "unsupported" }),
          searchTape: () => ({ matches: [], scannedEvents: 0, scope: "current_phase", query: "" }),
          record: (event: {
            sessionId: string;
            type: string;
            payload?: Record<string, unknown>;
          }) => {
            events.push({
              sessionId: event.sessionId,
              type: event.type,
              payload: event.payload,
            });
            return undefined;
          },
        },
      } as unknown as BrewvaRuntime,
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
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-info-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "validate tape tools",
    });

    const tools = createTapeTools({ runtime });
    const tapeHandoff = tools.find((tool) => tool.name === "tape_handoff");
    const tapeInfo = tools.find((tool) => tool.name === "tape_info");
    expect(tapeHandoff).toBeDefined();
    expect(tapeInfo).toBeDefined();

    const handoffResult = await tapeHandoff!.execute(
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
    expect(runtime.events.query(sessionId, { type: "anchor" }).length).toBe(1);

    runtime.events.record({
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
    runtime.events.record({
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

    const infoResult = await tapeInfo!.execute(
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
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-search";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.events.recordTapeHandoff(sessionId, {
      name: "investigation",
      summary: "Collected flaky test evidence.",
      nextSteps: "Implement fix.",
    });
    runtime.events.record({
      sessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: { id: "i1", text: "Fix flaky pipeline", status: "todo" },
      } as Record<string, unknown>,
    });

    const tools = createTapeTools({ runtime });
    const tapeSearch = tools.find((tool) => tool.name === "tape_search");
    expect(tapeSearch).toBeDefined();

    const result = await tapeSearch!.execute(
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
});
