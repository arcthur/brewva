import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createRecallExpandTool, createWorkbenchEvictTool } from "@brewva/brewva-tools/memory";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

const SESSION_ID = "session-rcr";

function createToolContext(sessionId = SESSION_ID) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function event(id: string, payload: Record<string, unknown>): BrewvaEventRecord {
  return { id, sessionId: SESSION_ID, type: "tool.committed", timestamp: 0, payload };
}

// A tool.committed event whose model-visible span is result.content.
function toolEvent(id: string, content: string): BrewvaEventRecord {
  return event(id, { result: { content } });
}

/**
 * Minimal runtime whose evict capability mirrors the gateway builder by storing
 * the reversible references the tool computes, so the full eviction -> expand
 * loop can be exercised without the hosted runtime.
 */
function createRcrRuntimeFixture(events: BrewvaEventRecord[]): BrewvaToolRuntime {
  const entries: WorkbenchEntry[] = [];
  return {
    identity: { cwd: "/tmp/brewva", workspaceRoot: "/tmp/brewva", agentId: "agent-test" },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {
      events: { records: { list: () => events } },
      workbench: {
        evict(
          _sessionId: string,
          input: {
            readonly spanRefs: readonly string[];
            readonly reason: string;
            readonly replacementNote?: string;
            readonly preservedQuotes?: readonly string[];
            readonly rcr?: WorkbenchEntry["rcr"];
          },
        ) {
          const entry = {
            id: `eviction-${entries.length + 1}`,
            kind: "eviction",
            content: input.replacementNote?.trim() ?? "",
            sourceRefs: [...input.spanRefs],
            reason: input.reason.trim(),
            createdTurn: entries.length + 1,
            digest: "digest-eviction",
            reversible: true,
            baselineCommitted: false,
            ...(input.rcr && input.rcr.length > 0 ? { rcr: input.rcr } : {}),
          } satisfies WorkbenchEntry;
          entries.push(entry);
          return entry;
        },
        list: () => entries,
      },
    } as unknown as BrewvaToolRuntime["capabilities"],
    extensions: {},
  };
}

function run(tool: ReturnType<typeof createWorkbenchEvictTool>, params: unknown) {
  return tool.execute(
    "call",
    params as never,
    new AbortController().signal,
    async () => undefined,
    createToolContext() as never,
  );
}

describe("rcr eviction and recall_expand loop", () => {
  test("evicting an event span attaches a reference recall_expand resolves to the original content", async () => {
    const runtime = createRcrRuntimeFixture([toolEvent("ev1", "the original tool output")]);
    const evicted = await run(createWorkbenchEvictTool({ runtime }), {
      span_refs: ["event:ev1"],
      reason: "tool output no longer needed as raw context",
    });
    const { entryId } = toolOutcomePayload(evicted) as { entryId: string };

    const expanded = await run(createRecallExpandTool({ runtime }), { entry_id: entryId });
    const payload = toolOutcomePayload(expanded) as {
      ok: boolean;
      resolved: number;
      results: { status: string; content?: string }[];
    };

    expect(payload.ok).toBe(true);
    expect(payload.resolved).toBe(1);
    expect(payload.results[0]?.status).toBe("resolved");
    expect(payload.results[0]?.content).toContain("the original tool output");
  });

  test("reproduces only the model-visible content, never internal event metadata", async () => {
    const runtime = createRcrRuntimeFixture([
      event("ev1", {
        commitmentId: "commit-secret-123",
        call: { toolName: "bash", args: { internalArg: "never-shown" } },
        result: { content: "the visible output", metadata: { ledgerId: "ledger-secret" } },
      }),
    ]);
    const evicted = await run(createWorkbenchEvictTool({ runtime }), {
      span_refs: ["event:ev1"],
      reason: "drop it",
    });
    const { entryId } = toolOutcomePayload(evicted) as { entryId: string };

    const expanded = await run(createRecallExpandTool({ runtime }), { entry_id: entryId });
    const payload = toolOutcomePayload(expanded) as {
      resolved: number;
      results: { content?: string }[];
    };
    const content = payload.results[0]?.content ?? "";

    expect(payload.resolved).toBe(1);
    expect(content).toContain("the visible output");
    expect(content).not.toContain("commit-secret-123");
    expect(content).not.toContain("ledger-secret");
    expect(content).not.toContain("never-shown");
  });

  test("recall_expand fails closed when the referenced event content drifts", async () => {
    const events = [toolEvent("ev1", "original")];
    const runtime = createRcrRuntimeFixture(events);
    const evicted = await run(createWorkbenchEvictTool({ runtime }), {
      span_refs: ["event:ev1"],
      reason: "drop it",
    });
    const { entryId } = toolOutcomePayload(evicted) as { entryId: string };

    // Simulate the referenced event no longer matching its snapshot.
    events[0] = toolEvent("ev1", "tampered");
    const expanded = await run(createRecallExpandTool({ runtime }), { entry_id: entryId });
    const payload = toolOutcomePayload(expanded) as {
      resolved: number;
      results: { status: string; reason?: string }[];
    };

    expect(payload.resolved).toBe(0);
    expect(payload.results[0]?.status).toBe("unresolvable_reference");
    expect(payload.results[0]?.reason).toBe("digest_mismatch");
  });

  test("recall_expand reports no reversible reference for a non-event eviction", async () => {
    const runtime = createRcrRuntimeFixture([toolEvent("ev1", "x")]);
    const evicted = await run(createWorkbenchEvictTool({ runtime }), {
      span_refs: ["turn:5"],
      reason: "drop a whole turn",
    });
    const { entryId } = toolOutcomePayload(evicted) as { entryId: string };

    const expanded = await run(createRecallExpandTool({ runtime }), { entry_id: entryId });
    const payload = toolOutcomePayload(expanded) as { ok: boolean; error?: string };

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("no_reversible_reference");
  });
});
