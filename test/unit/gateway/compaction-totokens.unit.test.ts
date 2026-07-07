import { describe, expect, test } from "bun:test";
import { estimateBrewvaCompactedContextTokens } from "@brewva/brewva-substrate/compaction";
import type { BrewvaSessionContext } from "@brewva/brewva-substrate/session";
import { createHostedCompactionController } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-telemetry.js";
import { ManagedSessionCompactionLifecycle } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/compaction-lifecycle.js";
import type { PreparedDeferredCompaction } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/session-contracts.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const KEPT_MESSAGES = [
  { role: "user", content: "keep this recent instruction" },
  { role: "assistant", content: "acknowledged, continuing the task" },
];

// A typed minimal post-compaction context. Only `messages` is read by build();
// the control-state fields satisfy the BrewvaSessionContext contract so the
// fixture does not silently drift from it.
function sessionContext(messages: readonly unknown[]): BrewvaSessionContext {
  return {
    messages: messages as BrewvaSessionContext["messages"],
    thinkingLevel: "off",
    model: null,
    activeModelPresetName: "default",
    activeModelPreset: {
      name: "default",
      roles: {} as BrewvaSessionContext["activeModelPreset"]["roles"],
    },
  };
}

// build() does not exercise the lifecycle dependencies; the cast isolates the
// system under test while keeping the single shared setup in one place.
function createCompactionLifecycle(): ManagedSessionCompactionLifecycle {
  return new ManagedSessionCompactionLifecycle({
    cwd: "/tmp",
    emitToListeners: () => {},
    replaceMessages: async () => {},
    markSessionCompacted: async () => {},
  } as unknown as ConstructorParameters<typeof ManagedSessionCompactionLifecycle>[0]);
}

// `satisfies` enforces the full PreparedDeferredCompaction contract — including
// the required cutPointReason — instead of an `as unknown` cast that would hide
// a missing field as the contract evolves.
function createPreparedCompaction(
  previewOverrides: Partial<PreparedDeferredCompaction["preview"]> = {},
): PreparedDeferredCompaction {
  return {
    request: {},
    sessionId: "s1",
    branchEntries: [],
    originalContext: sessionContext([]),
    sourceLeafEntryId: null,
    summary: "Goal: keep working.",
    summaryGeneration: { strategy: "llm_primary" },
    pruneOperations: [],
    pruneTokensSaved: 0,
    preview: {
      compactId: "c1",
      sourceLeafEntryId: null,
      firstKeptEntryId: "entry-1",
      context: sessionContext(KEPT_MESSAGES),
      tokensBefore: 9_000,
      summary: "Goal: keep working.",
      cutPointReason: "tail_budget",
      ...previewOverrides,
    },
  } satisfies PreparedDeferredCompaction;
}

describe("compaction post-compaction token count", () => {
  test("threads compaction-entry toTokens into the committed receipt when no usage is measured", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "compact-totokens-session";
    const controller = createHostedCompactionController(
      runtime,
      createHostedContextTelemetry(runtime),
    );

    // Deferred/auto compaction commits without a provider usage measurement;
    // the post-compaction token count rides on the compaction entry instead.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: {
        id: "compact-1",
        summary: "summary",
        firstKeptEntryId: "entry-1",
        toTokens: 321,
      },
    });

    const committed = runtime.ops.events.records
      .query(sessionId, { type: "session.compaction.committed" })
      .at(-1)?.payload;

    expect(committed).toMatchObject({ compactId: "compact-1", toTokens: 321 });
  });

  test("threads compaction-entry tokensBefore into the committed receipt fromTokens", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "compact-fromtokens-session";
    const controller = createHostedCompactionController(
      runtime,
      createHostedContextTelemetry(runtime),
    );

    // No provider usage is observed; the authoritative pre-compaction count rides
    // on the entry (like toTokens) so a shrink ratio can be derived from the receipt.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: {
        id: "compact-1",
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 9_000,
        toTokens: 321,
      },
    });

    const committed = runtime.ops.events.records
      .query(sessionId, { type: "session.compaction.committed" })
      .at(-1)?.payload;

    expect(committed).toMatchObject({ compactId: "compact-1", fromTokens: 9_000, toTokens: 321 });
  });

  test("records the post-compaction estimate, not a stale pre-compaction usage reading", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "compact-totokens-usage-session";
    const controller = createHostedCompactionController(
      runtime,
      createHostedContextTelemetry(runtime),
    );

    // `usage` is the pre-compaction context size (what getContextUsage still
    // reports at emit time, since replaceMessages does not recompute it). It
    // must not be recorded as the post-compaction token count; the entry's
    // post-compaction estimate wins.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: {
        id: "compact-2",
        summary: "summary",
        firstKeptEntryId: "entry-1",
        toTokens: 321,
      },
      usage: { tokens: 512, contextWindow: 2_000, percent: null },
    });

    const committed = runtime.ops.events.records
      .query(sessionId, { type: "session.compaction.committed" })
      .at(-1)?.payload;

    expect(committed).toMatchObject({ compactId: "compact-2", toTokens: 321 });
  });

  test("build derives the post-compaction token count from the compacted context", () => {
    const built = createCompactionLifecycle().build(createPreparedCompaction());

    const expected = estimateBrewvaCompactedContextTokens(KEPT_MESSAGES);
    expect(expected).toBeGreaterThan(0);
    expect(built.compactEvent.compactionEntry).toMatchObject({ toTokens: expected });
  });

  test("records the cut-point reason on the committed receipt for oversized-turn observability", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "compact-cutpoint-reason-session";
    const controller = createHostedCompactionController(
      runtime,
      createHostedContextTelemetry(runtime),
    );

    await controller.sessionCompact({
      sessionId,
      compactionEntry: {
        id: "compact-1",
        summary: "summary",
        firstKeptEntryId: "entry-1",
        toTokens: 100,
        cutPointReason: "oversized_active_turn",
      },
    });

    const committed = runtime.ops.events.records
      .query(sessionId, { type: "session.compaction.committed" })
      .at(-1)?.payload;

    expect(committed).toMatchObject({
      compactId: "compact-1",
      cutPointReason: "oversized_active_turn",
    });
  });

  test("build threads the cut-point reason from the preview onto the compaction entry", () => {
    const built = createCompactionLifecycle().build(
      createPreparedCompaction({ cutPointReason: "oversized_active_turn" }),
    );

    expect(built.compactEvent.compactionEntry).toMatchObject({
      cutPointReason: "oversized_active_turn",
    });
  });

  test("build threads the pre-compaction token count from the preview onto the compaction entry", () => {
    const built = createCompactionLifecycle().build(createPreparedCompaction());

    // Locks the auto-path link feeding the effectiveness guard: preview.tokensBefore
    // must ride on the compaction entry so the committed receipt carries fromTokens.
    expect(built.compactEvent.compactionEntry).toMatchObject({ tokensBefore: 9_000 });
  });
});
