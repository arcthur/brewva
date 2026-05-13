import { describe, expect, test } from "bun:test";
import type { WorkbenchEntry } from "@brewva/brewva-runtime/workbench";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import {
  createWorkbenchEvictTool,
  createWorkbenchNoteTool,
  createWorkbenchUndoEvictTool,
} from "@brewva/brewva-tools/memory";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";

function createToolContext(sessionId = "session-workbench") {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function createToolRuntimeFixture(): BrewvaToolRuntime {
  const entries: WorkbenchEntry[] = [];
  return {
    identity: {
      cwd: "/tmp/brewva",
      workspaceRoot: "/tmp/brewva",
      agentId: "agent-test",
    },
    config: {} as BrewvaToolRuntime["config"],
    authority: {
      workbench: {
        note(_sessionId: string, input) {
          const entry = {
            id: `note-${entries.length + 1}`,
            kind: "note",
            content: input.content.trim(),
            sourceRefs: [...(input.sourceRefs ?? [])],
            reason: input.reason.trim(),
            createdTurn: entries.length + 1,
            digest: "digest-note",
            reversible: false,
            baselineCommitted: false,
          } satisfies WorkbenchEntry;
          entries.push(entry);
          return entry;
        },
        evict(_sessionId: string, input) {
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
            preservedQuotes: [...(input.preservedQuotes ?? [])],
          } satisfies WorkbenchEntry;
          entries.push(entry);
          return entry;
        },
        undoEviction(_sessionId: string, entryId: string, _reason?: string) {
          const index = entries.findIndex(
            (entry) =>
              entry.id === entryId &&
              entry.kind === "eviction" &&
              entry.reversible &&
              !entry.baselineCommitted,
          );
          if (index < 0) {
            return { undone: false };
          }
          const [entry] = entries.splice(index, 1);
          return {
            undone: true,
            entry: {
              ...entry!,
              undoneAtTurn: entries.length + 2,
            },
          };
        },
      },
    } as BrewvaToolRuntime["authority"],
    inspect: {} as BrewvaToolRuntime["inspect"],
    extensions: {},
  };
}

describe("workbench memory tools", () => {
  test("workbench_note records model-authored notebook entries", async () => {
    const runtime = createToolRuntimeFixture();
    const tool = createWorkbenchNoteTool({ runtime });

    const result = await tool.execute(
      "call-workbench-note",
      {
        content: "Current objective: replace hidden context admission with model-operated memory.",
        source_refs: ["turn:12", "file:docs/rfc.md"],
        reason: "Preserve the active objective before compaction.",
        retention_hint: "session",
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(result.details).toMatchObject({
      ok: true,
      entryId: "note-1",
      kind: "note",
      sourceRefs: ["turn:12", "file:docs/rfc.md"],
      retentionHint: "session",
    });
    expect(textContent(result)).toContain("[WorkbenchNote]");
    expect(getBrewvaToolMetadata(tool)?.requiredCapabilities).toEqual(["authority.workbench.note"]);
  });

  test("workbench_note requires source refs at the model tool boundary", async () => {
    const runtime = createToolRuntimeFixture();
    const tool = createWorkbenchNoteTool({ runtime });

    const result = await tool.execute(
      "call-workbench-note",
      {
        content: "Current objective: keep the model-operated workbench minimal.",
        source_refs: [],
        reason: "No source ref should be accepted for model-authored notes.",
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: "missing_content_reason_or_source_refs",
    });
  });

  test("workbench_evict records reversible evictions with optional replacement notes", async () => {
    const runtime = createToolRuntimeFixture();
    const tool = createWorkbenchEvictTool({ runtime });

    const result = await tool.execute(
      "call-workbench-evict",
      {
        span_refs: ["tool:exec:turn-10", "turn:9..11"],
        replacement_note: "The failed provider-registry path was removed; do not retry it.",
        reason: "Tool output is no longer useful as raw context.",
        preserved_quotes: ["delete provider registry"],
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(result.details).toMatchObject({
      ok: true,
      entryId: "eviction-1",
      kind: "eviction",
      spanRefs: ["tool:exec:turn-10", "turn:9..11"],
      reversible: true,
    });
    expect(textContent(result)).toContain("[WorkbenchEvict]");
    expect(getBrewvaToolMetadata(tool)?.requiredCapabilities).toEqual([
      "authority.workbench.evict",
    ]);
  });

  test("workbench_evict rejects unrenderable span ref prefixes", async () => {
    const runtime = createToolRuntimeFixture();
    const tool = createWorkbenchEvictTool({ runtime });

    const result = await tool.execute(
      "call-workbench-evict",
      {
        span_refs: ["topic:old-registry"],
        reason: "Only renderable transcript refs can be evicted.",
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: "invalid_span_refs",
      invalidRefs: ["topic:old-registry"],
    });
  });

  test("workbench_undo_evict restores reversible eviction attention", async () => {
    const runtime = createToolRuntimeFixture();
    runtime.authority?.workbench.evict("session-workbench", {
      spanRefs: ["tool:exec:turn-10"],
      replacementNote: "A temporary eviction.",
      reason: "The raw output looked stale.",
    });
    const tool = createWorkbenchUndoEvictTool({ runtime });

    const result = await tool.execute(
      "call-workbench-undo-evict",
      {
        entry_id: "eviction-1",
        reason: "The model needs to inspect the raw output again.",
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(result.details).toMatchObject({
      ok: true,
      entryId: "eviction-1",
      reason: "The model needs to inspect the raw output again.",
    });
    expect(textContent(result)).toContain("[WorkbenchUndoEvict]");
    expect(getBrewvaToolMetadata(tool)?.requiredCapabilities).toEqual([
      "authority.workbench.undoEviction",
    ]);
  });
});
