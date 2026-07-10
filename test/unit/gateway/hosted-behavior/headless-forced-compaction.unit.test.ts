import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/context";
import { setStaticContextStatusThresholds } from "../../../fixtures/config.js";
import { invokeHandler, invokeHandlerAsync } from "../../../helpers/extension.js";
import { patchProcessEnv } from "../../../helpers/global-state.js";
import {
  createMockExtensionApi,
  createRuntimeConfig,
  createRuntimeFixture,
  registerContextTransform,
} from "./context-transform.helpers.js";

const FORCE_ENV = "BREWVA_EVAL_FORCE_COMPACTION";
const SESSION_COMPACTION_COMMITTED_TYPE = "session.compaction.committed";
const CONTEXT_COMPACTION_DEFERRED_TYPE = "context_compaction_deferred";

let restoreEnv: (() => void) | null = null;

function setForceCompactionEnv(value: string | undefined): void {
  restoreEnv = patchProcessEnv({ [FORCE_ENV]: value });
}

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
});

interface CompactRequest {
  customInstructions?: string;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

function createHarness(input: { hardRatio: number; advisoryRatio?: number }) {
  const runtime = createRuntimeFixture({
    config: createRuntimeConfig((draft) => {
      setStaticContextStatusThresholds(draft, {
        hardRatio: input.hardRatio,
        ...(input.advisoryRatio !== undefined ? { advisoryRatio: input.advisoryRatio } : {}),
      });
      // Zero the growth prediction so the pressure reason in assertions is
      // exactly usage-derived (no predicted_overflow flakiness).
      draft.infrastructure.contextBudget.predictedTurnGrowthTokens = 0;
    }),
  });
  const extension = createMockExtensionApi();
  registerContextTransform(extension.api, runtime);
  return { runtime, extension };
}

function buildHeadlessContext(input: {
  sessionId: string;
  usageTokens: number;
  compactRequests?: CompactRequest[];
  hasUI?: boolean;
}) {
  return {
    sessionManager: { getSessionId: () => input.sessionId },
    hasUI: input.hasUI ?? false,
    isIdle: () => false,
    getContextUsage: () => ({
      tokens: input.usageTokens,
      contextWindow: 1_000,
      percent: input.usageTokens / 1_000,
    }),
    compact: (request: CompactRequest) => {
      input.compactRequests?.push(request);
    },
  };
}

describe("headless forced compaction (BREWVA_EVAL_FORCE_COMPACTION)", () => {
  test("hard-limit pressure at before_provider_request commits session compaction on the tape", async () => {
    setForceCompactionEnv("1");
    const { runtime, extension } = createHarness({ hardRatio: 0.8 });
    const sessionId = "headless-forced";
    const compactRequests: CompactRequest[] = [];
    // Mid-turn shape of the failing sessions: usage over the hard limit is only
    // observed after a provider response, so the once-per-turn `context` hook
    // never saw it — the per-request check must arm the deferred soft cut.
    const ctx = buildHeadlessContext({ sessionId, usageTokens: 950, compactRequests });

    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, ctx);

    expect(compactRequests).toHaveLength(1);
    const requested = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
    });
    expect(requested.at(-1)?.payload).toMatchObject({ reason: "hard_limit" });

    // The deferred coordinator flushes at the next committed tool result /
    // turn end by emitting session_compact — replay that half here.
    await invokeHandlerAsync(
      extension.handlers,
      "session_compact",
      { compactionEntry: { id: "cmp-forced", summary: "compacted", toTokens: 200 } },
      buildHeadlessContext({ sessionId, usageTokens: 200 }),
    );
    compactRequests[0]?.onComplete?.();

    const committed = runtime.ops.events.records.query(sessionId, {
      type: SESSION_COMPACTION_COMMITTED_TYPE,
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toMatchObject({ compactId: "cmp-forced" });
  });

  test("without the env flag the headless skip stays non_interactive_mode and is receipted once per episode", () => {
    setForceCompactionEnv(undefined);
    const { runtime, extension } = createHarness({ hardRatio: 0.8 });
    const sessionId = "headless-default";
    const compactRequests: CompactRequest[] = [];
    const ctx = buildHeadlessContext({ sessionId, usageTokens: 950, compactRequests });

    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, ctx);
    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, ctx);

    expect(compactRequests).toHaveLength(0);
    const skipped = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
    });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({ reason: "non_interactive_mode" });
  });

  test("agent-active deferral receipts carry the pressure reason, dedupe per episode, and never emit null clears", () => {
    setForceCompactionEnv(undefined);
    const { runtime, extension } = createHarness({ hardRatio: 0.9, advisoryRatio: 0.75 });
    const sessionId = "deferred-reason";
    const compactRequests: CompactRequest[] = [];
    const pressured = buildHeadlessContext({
      sessionId,
      usageTokens: 800,
      compactRequests,
      hasUI: true,
    });

    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, pressured);
    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, pressured);

    let deferred = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_DEFERRED_TYPE,
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.payload).toMatchObject({ reason: "usage_threshold" });
    expect(compactRequests).toHaveLength(0);

    // Pressure clears (no_request): the clear must not fabricate a receipt.
    invokeHandler(
      extension.handlers,
      "before_provider_request",
      { payload: {} },
      buildHeadlessContext({ sessionId, usageTokens: 100, hasUI: true }),
    );
    deferred = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_DEFERRED_TYPE,
    });
    expect(deferred).toHaveLength(1);

    // A new pressure episode re-arms the receipt.
    invokeHandler(extension.handlers, "before_provider_request", { payload: {} }, pressured);
    deferred = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_DEFERRED_TYPE,
    });
    expect(deferred).toHaveLength(2);
    expect(deferred.every((event) => (event.payload as { reason?: unknown }).reason !== null)).toBe(
      true,
    );
  });
});
