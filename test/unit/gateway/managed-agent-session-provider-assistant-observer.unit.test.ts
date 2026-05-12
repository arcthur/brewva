import { describe, expect, test } from "bun:test";
import { ManagedSessionProviderAssistantObserver } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-assistant-observer.js";

describe("managed-agent-session provider assistant observer", () => {
  test("skips observation when runtime fingerprint state is incomplete", () => {
    let observed = 0;
    const observer = new ManagedSessionProviderAssistantObserver({
      runtime: undefined,
      workspaceRoot: "/tmp/demo",
      sessionId: "sess-1",
      googleCachedContentManager: {
        markUnsupportedFromStreamError: () => undefined,
        observeUsage: () => undefined,
      },
      cacheBreakDetector: {
        observe: () => {
          observed += 1;
          return {
            status: "expected",
            classification: "expected",
            expected: true,
            reason: "missing_state",
            source: "bucket",
            observedAt: 0,
            cacheRead: 0,
            cacheWrite: 0,
            thresholdTokens: 0,
            relativeDropThreshold: 0,
            fingerprintDriftKeys: [],
          } as never;
        },
      },
      resolveExpectedBreak: () => undefined,
      state: () => ({
        lastProviderFingerprint: undefined,
        lastCacheRender: undefined,
        lastGoogleModelBaseUrl: undefined,
      }),
    });

    observer.onCommittedAssistantMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      stopReason: "stop",
      timestamp: 1,
    } as never);

    expect(observed).toBe(0);
  });
});
