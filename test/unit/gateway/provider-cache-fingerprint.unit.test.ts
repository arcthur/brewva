import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderCacheBreakDetector,
  ProviderCacheStickyLatches,
  createProviderRequestFingerprint,
  createToolSchemaSnapshot,
  createToolSchemaSnapshotStore,
} from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/index.js";

describe("provider cache fingerprinting", () => {
  test("attributes tool schema drift with per-tool hashes", () => {
    const previous = createToolSchemaSnapshot([
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const next = createToolSchemaSnapshot([
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "read",
        description: "Read a file safely",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    expect(previous.hash).not.toBe(next.hash);
    expect(previous.perToolHashes.write).toBe(next.perToolHashes.write);
    expect(previous.perToolHashes.read).not.toBe(next.perToolHashes.read);
  });

  test("keeps a session-stable tool schema snapshot across same-name drift", () => {
    const store = createToolSchemaSnapshotStore();
    const first = store.resolve(
      [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      "initial",
    );

    const drifted = store.resolve(
      [
        {
          name: "read",
          description: "Read a file with dynamic refreshed prose",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      "runtime_refresh",
    );

    expect(drifted.epoch).toBe(first.epoch);
    expect(drifted.hash).toBe(first.hash);
    expect(drifted.tools[0]?.description).toBe("Read a file");
    expect(drifted.driftedToolNames).toEqual(["read"]);

    const changedSet = store.resolve(
      [
        {
          name: "read",
          description: "Read a file with dynamic refreshed prose",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "write",
          description: "Write a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      "active_tool_set_changed",
    );

    expect(changedSet.epoch).toBe(first.epoch + 1);
    expect(changedSet.hash).not.toBe(first.hash);
    expect(changedSet.invalidationReason).toBe("active_tool_set_changed");
  });

  test("keeps recall and channel context in dynamic-tail hashes", () => {
    const snapshot = createToolSchemaSnapshot([]);
    const fingerprint = createProviderRequestFingerprint({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4",
      transport: "sse",
      sessionId: "session-cache",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: snapshot,
      stablePrefixParts: ["system prompt", "stable tool prelude"],
      dynamicTailParts: ["model-requested recall results", "telegram channel context"],
      channelContext: "telegram",
      renderedCache: {
        status: "rendered",
        reason: "rendered_openai_prompt_cache",
        renderedRetention: "short",
        bucketKey: "openai-responses|session=session-cache|retention=short|writeMode=readWrite",
        capability: {
          strategies: ["promptCacheKey"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "24h",
          readOnlyWriteMode: "unsupported",
          reason: "openai_responses_prompt_cache_key",
        },
      },
      stickyLatches: {
        providerCacheRetained: true,
        providerCacheEdit: false,
        lowLatencyTransport: false,
        reasoningTransport: true,
        channelCapability: true,
      },
      reasoning: "high",
      thinkingBudgets: { high: 16_384 },
      cacheRelevantHeaders: { "x-provider-beta": "cache-control" },
      extraBody: { output_config: { effort: "high" } },
      visibleHistoryReduction: { epoch: 1, status: "none" },
      workbenchContext: { present: true, scope: "dynamic_tail" },
      providerFallback: { active: false },
      payload: {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        apiKey: "redacted by hash",
      },
    });

    expect(fingerprint.stablePrefixHash).not.toBe(fingerprint.dynamicTailHash);
    expect(fingerprint.channelContextHash).not.toBe("");
    expect(fingerprint.renderedCacheHash).not.toBe("");
    expect(fingerprint.cacheCapabilityHash).not.toBe("");
    expect(fingerprint.stickyLatchHash).not.toBe("");
    expect(fingerprint.reasoningHash).not.toBe("");
    expect(fingerprint.thinkingBudgetHash).not.toBe("");
    expect(fingerprint.cacheRelevantHeadersHash).not.toBe("");
    expect(fingerprint.extraBodyHash).not.toBe("");
    expect(fingerprint.visibleHistoryReductionHash).not.toBe("");
    expect(fingerprint.workbenchContextHash).not.toBe("");
    expect(fingerprint.providerFallbackHash).not.toBe("");
    expect(fingerprint.requestHash).not.toContain("redacted by hash");
    for (const [field, value] of Object.entries(fingerprint)) {
      if (field.endsWith("Hash") && typeof value === "string") {
        expect(value).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
    for (const value of Object.values(fingerprint.perToolHashes)) {
      expect(value).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  test("suppresses expected breaks while surfacing unexpected cache-read drops", () => {
    const detector = new ProviderCacheBreakDetector();
    const baseFingerprint = createProviderRequestFingerprint({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4",
      transport: "sse",
      sessionId: "session-cache-break",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "first" },
    });

    expect(
      detector.observe({
        source: "session-cache-break",
        fingerprint: baseFingerprint,
        usage: { cacheRead: 10_000, cacheWrite: 500 },
      }),
    ).toEqual(expect.objectContaining({ status: "cold" }));

    const expectedBreak = detector.observe({
      source: "session-cache-break",
      fingerprint: { ...baseFingerprint, requestHash: "expected-reset" },
      usage: { cacheRead: 0, cacheWrite: 10_500 },
      expectedBreak: { classification: "prefixResetting", reason: "cache_deletions_pending" },
    });
    expect(expectedBreak).toEqual(
      expect.objectContaining({
        status: "break",
        expected: true,
        classification: "prefixResetting",
      }),
    );

    const unexpectedSource = "session-cache-break-unexpected";
    detector.observe({
      source: unexpectedSource,
      fingerprint: baseFingerprint,
      usage: { cacheRead: 10_000, cacheWrite: 500 },
    });
    const unexpectedBreak = detector.observe({
      source: unexpectedSource,
      fingerprint: { ...baseFingerprint, requestHash: "unexpected-reset" },
      usage: { cacheRead: 1_000, cacheWrite: 9_500 },
    });
    expect(unexpectedBreak).toEqual(
      expect.objectContaining({
        status: "break",
        expected: false,
        classification: "prefixPreserving",
        cacheMissTokens: 9_000,
      }),
    );
  });

  test("keeps no-op turns warm when cache-read tokens do not drop", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4",
      transport: "sse",
      sessionId: "warm-noop",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: [{ lastMessages: [] }],
      channelContext: "",
      payload: { input: "same" },
    });

    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      usage: { cacheRead: 4_000, cacheWrite: 200 },
    });
    expect(
      detector.observe({
        source: fingerprint.bucketKey,
        fingerprint,
        usage: { cacheRead: 4_500, cacheWrite: 0 },
      }),
    ).toEqual(
      expect.objectContaining({
        status: "warm",
        cacheMissTokens: 0,
      }),
    );
  });

  test("advances the baseline after an expected cache break", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4",
      transport: "sse",
      sessionId: "expected-break-baseline",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "first" },
    });

    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      usage: { cacheRead: 10_000, cacheWrite: 500 },
    });
    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint: { ...fingerprint, requestHash: "expected-reset" },
      usage: { cacheRead: 0, cacheWrite: 10_500 },
      expectedBreak: { classification: "prefixResetting", reason: "cache_deletions_pending" },
    });

    expect(
      detector.observe({
        source: fingerprint.bucketKey,
        fingerprint: { ...fingerprint, requestHash: "post-reset" },
        usage: { cacheRead: 0, cacheWrite: 1_000 },
      }),
    ).toEqual(
      expect.objectContaining({
        status: "warm",
        expected: false,
        cacheMissTokens: 0,
      }),
    );
  });

  test("reports limited observability when provider cache counters are unavailable", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "local",
      api: "openai-responses",
      model: "edge-model",
      transport: "sse",
      sessionId: "limited-observability",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "first" },
    });

    const observation = detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      usage: { cacheRead: 0, cacheWrite: 0 },
      observability: {
        cacheCountersAvailable: false,
        reason: "provider_cache_counters_unavailable",
      },
    });

    expect(observation).toEqual(
      expect.objectContaining({
        status: "limited",
        classification: "cacheCold",
        expected: false,
        reason: "provider_cache_counters_unavailable",
      }),
    );
  });

  test("dumps unexpected break diagnostics when explicitly enabled", () => {
    const diagnosticsDir = mkdtempSync(join(tmpdir(), "brewva-cache-break-"));
    try {
      const detector = new ProviderCacheBreakDetector({
        diagnosticDumpDirectory: diagnosticsDir,
      });
      const fingerprint = createProviderRequestFingerprint({
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        transport: "sse",
        sessionId: "dump-break",
        cachePolicy: {
          retention: "short",
          writeMode: "readWrite",
          scope: "session",
          reason: "default",
        },
        toolSchemaSnapshot: createToolSchemaSnapshot([]),
        stablePrefixParts: ["stable"],
        dynamicTailParts: ["tail"],
        channelContext: "",
        payload: { input: "first" },
      });

      detector.observe({
        source: fingerprint.bucketKey,
        fingerprint,
        usage: { cacheRead: 10_000, cacheWrite: 500 },
        observedAt: 1,
      });
      detector.observe({
        source: fingerprint.bucketKey,
        fingerprint: { ...fingerprint, requestHash: "unexpected-reset" },
        usage: { cacheRead: 0, cacheWrite: 10_000 },
        observedAt: 2,
      });

      expect(readdirSync(diagnosticsDir).some((file) => file.startsWith("cache-break-"))).toBe(
        true,
      );
    } finally {
      rmSync(diagnosticsDir, { force: true, recursive: true });
    }
  });

  test("treats zero reasoning budgets as reasoning disabled for sticky latches", () => {
    const latches = new ProviderCacheStickyLatches();
    expect(latches.observe({ reasoning: { thinkingBudgetTokens: 0 } }).reasoningTransport).toBe(
      false,
    );
    expect(latches.observe({ reasoning: { thinkingBudgetTokens: 1024 } }).reasoningTransport).toBe(
      true,
    );
    expect(latches.observe({ reasoning: { thinkingBudgetTokens: 0 } }).reasoningTransport).toBe(
      true,
    );
  });

  test("classifies likely TTL expiry separately from client-side drift", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-4-sonnet",
      transport: "sse",
      sessionId: "ttl-break",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "same" },
    });

    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      usage: { cacheRead: 12_000, cacheWrite: 200 },
      observedAt: 0,
    });
    const observation = detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      usage: { cacheRead: 100, cacheWrite: 12_000 },
      observedAt: 6 * 60 * 1000,
    });

    expect(observation).toEqual(
      expect.objectContaining({
        status: "break",
        expected: false,
        reason: "possible_cache_ttl_expiry_5m",
        changedFields: [],
      }),
    );
  });

  test("uses rendered Google cached-content TTL instead of the generic 1h label", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "google-genai",
      api: "google-genai",
      model: "gemini-2.5-pro",
      transport: "sse",
      sessionId: "google-explicit-cache",
      cachePolicy: {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "config",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "same" },
    });

    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      render: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-explicit-cache|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 7_200,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      usage: { cacheRead: 12_000, cacheWrite: 200 },
      observedAt: 0,
    });
    const observation = detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      render: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-explicit-cache|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 7_200,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      usage: { cacheRead: 100, cacheWrite: 12_000 },
      observedAt: 2 * 60 * 60 * 1000,
    });

    expect(observation).toEqual(
      expect.objectContaining({
        status: "break",
        expected: false,
        reason: "possible_cache_ttl_expiry_2h",
      }),
    );
  });

  test("ignores zero-second explicit cache TTLs when classifying unexpected breaks", () => {
    const detector = new ProviderCacheBreakDetector();
    const fingerprint = createProviderRequestFingerprint({
      provider: "google-genai",
      api: "google-genai",
      model: "gemini-2.5-pro",
      transport: "sse",
      sessionId: "google-zero-ttl",
      cachePolicy: {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "config",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      payload: { input: "same" },
    });

    detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      render: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-zero-ttl|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 0,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      usage: { cacheRead: 12_000, cacheWrite: 200 },
      observedAt: 0,
    });
    const observation = detector.observe({
      source: fingerprint.bucketKey,
      fingerprint,
      render: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-zero-ttl|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 0,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      usage: { cacheRead: 100, cacheWrite: 12_000 },
      observedAt: 10 * 1000,
    });

    expect(observation.reason).toBe("cache_read_drop_exceeded_threshold");
  });

  test("request fingerprints change once Google cachedContent is injected into the payload", () => {
    const sharedInput = {
      provider: "google-genai" as const,
      api: "google-genai" as const,
      model: "gemini-2.5-pro",
      transport: "sse" as const,
      sessionId: "google-injected-cache",
      cachePolicy: {
        retention: "long" as const,
        writeMode: "readWrite" as const,
        scope: "session" as const,
        reason: "config" as const,
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
    };

    const before = createProviderRequestFingerprint({
      ...sharedInput,
      renderedCache: {
        status: "unsupported",
        reason: "cached_content_resource_unavailable",
        renderedRetention: "none",
        bucketKey: "google-genai|session=google-injected-cache|retention=none|writeMode=readWrite",
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      payload: {
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    });
    const after = createProviderRequestFingerprint({
      ...sharedInput,
      renderedCache: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-injected-cache|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 3600,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      payload: {
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        config: {
          cachedContent: "cachedContents/brewva-google-genai",
        },
      },
    });

    expect(after.requestHash).not.toBe(before.requestHash);
    expect(after.renderedCacheHash).not.toBe(before.renderedCacheHash);
  });

  test("switching Google cache mode from short implicit to long explicit starts a new cold bucket instead of reporting a break", () => {
    const detector = new ProviderCacheBreakDetector();
    const shortFingerprint = createProviderRequestFingerprint({
      provider: "google-genai",
      api: "google-genai",
      model: "gemini-2.5-pro",
      transport: "sse",
      sessionId: "google-mode-switch",
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      renderedCache: {
        status: "rendered",
        reason: "rendered_google_genai_implicit_prefix_cache",
        renderedRetention: "short",
        bucketKey: "google-genai|session=google-mode-switch|retention=short|writeMode=readWrite",
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      payload: { model: "gemini-2.5-pro", contents: [{ role: "user", text: "hi" }] },
    });
    const longFingerprint = createProviderRequestFingerprint({
      provider: "google-genai",
      api: "google-genai",
      model: "gemini-2.5-pro",
      transport: "sse",
      sessionId: "google-mode-switch",
      cachePolicy: {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "config",
      },
      toolSchemaSnapshot: createToolSchemaSnapshot([]),
      stablePrefixParts: ["stable"],
      dynamicTailParts: ["tail"],
      channelContext: "",
      renderedCache: {
        status: "rendered",
        reason: "rendered_google_genai_cached_content",
        renderedRetention: "long",
        bucketKey: "google-genai|session=google-mode-switch|retention=long|writeMode=readWrite",
        cachedContentName: "cachedContents/brewva-google-genai",
        cachedContentTtlSeconds: 3600,
        capability: {
          strategies: ["implicitPrefix", "explicitCachedContent"],
          cacheCounters: "readOnly",
          shortRetention: true,
          longRetention: "1h",
          readOnlyWriteMode: "supported",
          reason: "google_genai_context_caching",
        },
      },
      payload: {
        model: "gemini-2.5-pro",
        contents: [{ role: "user", text: "hi" }],
        config: {
          cachedContent: "cachedContents/brewva-google-genai",
        },
      },
    });

    expect(shortFingerprint.bucketKey).not.toBe(longFingerprint.bucketKey);
    expect(
      detector.observe({
        source: shortFingerprint.bucketKey,
        fingerprint: shortFingerprint,
        render: {
          status: "rendered",
          reason: "rendered_google_genai_implicit_prefix_cache",
          renderedRetention: "short",
          bucketKey: "google-genai|session=google-mode-switch|retention=short|writeMode=readWrite",
          capability: {
            strategies: ["implicitPrefix", "explicitCachedContent"],
            cacheCounters: "readOnly",
            shortRetention: true,
            longRetention: "1h",
            readOnlyWriteMode: "supported",
            reason: "google_genai_context_caching",
          },
        },
        usage: { cacheRead: 0, cacheWrite: 0 },
      }),
    ).toEqual(expect.objectContaining({ status: "cold" }));
    expect(
      detector.observe({
        source: longFingerprint.bucketKey,
        fingerprint: longFingerprint,
        render: {
          status: "rendered",
          reason: "rendered_google_genai_cached_content",
          renderedRetention: "long",
          bucketKey: "google-genai|session=google-mode-switch|retention=long|writeMode=readWrite",
          cachedContentName: "cachedContents/brewva-google-genai",
          cachedContentTtlSeconds: 3600,
          capability: {
            strategies: ["implicitPrefix", "explicitCachedContent"],
            cacheCounters: "readOnly",
            shortRetention: true,
            longRetention: "1h",
            readOnlyWriteMode: "supported",
            reason: "google_genai_context_caching",
          },
        },
        usage: { cacheRead: 8_000, cacheWrite: 0 },
      }),
    ).toEqual(expect.objectContaining({ status: "cold" }));
  });

  test("attributes an unexpected break to the tool schema when only the schema set changed", () => {
    const detector = new ProviderCacheBreakDetector();
    const sharedInput = {
      provider: "anthropic" as const,
      api: "anthropic-messages" as const,
      model: "claude-4-sonnet",
      transport: "sse" as const,
      sessionId: "tool-schema-break",
      cachePolicy: {
        retention: "short" as const,
        writeMode: "readWrite" as const,
        scope: "session" as const,
        reason: "default" as const,
      },
      stablePrefixParts: ["stable system prompt"],
      dynamicTailParts: ["tail"],
      channelContext: "",
    };
    const baseFingerprint = createProviderRequestFingerprint({
      ...sharedInput,
      toolSchemaSnapshot: createToolSchemaSnapshot([
        { name: "read", description: "Read a file", parameters: { type: "object" } },
      ]),
      payload: { input: "first" },
    });
    const expandedFingerprint = createProviderRequestFingerprint({
      ...sharedInput,
      toolSchemaSnapshot: createToolSchemaSnapshot([
        { name: "read", description: "Read a file", parameters: { type: "object" } },
        { name: "browser_click", description: "Click an element", parameters: { type: "object" } },
      ]),
      payload: { input: "second" },
    });

    detector.observe({
      source: baseFingerprint.bucketKey,
      fingerprint: baseFingerprint,
      usage: { cacheRead: 10_000, cacheWrite: 500 },
    });
    const observation = detector.observe({
      source: baseFingerprint.bucketKey,
      fingerprint: expandedFingerprint,
      usage: { cacheRead: 1_000, cacheWrite: 9_500 },
    });

    expect(observation).toEqual(
      expect.objectContaining({
        status: "break",
        expected: false,
        reason: "tool_schema_set_changed",
      }),
    );
    expect(observation.changedFields).toContain("toolSchemaSnapshotHash");
    expect(observation.changedFields).toContain("tool:browser_click");
  });

  test("keeps the generic break reason when a non-schema prefix field also changed", () => {
    const detector = new ProviderCacheBreakDetector();
    const sharedInput = {
      provider: "anthropic" as const,
      api: "anthropic-messages" as const,
      model: "claude-4-sonnet",
      transport: "sse" as const,
      sessionId: "tool-schema-ambiguous-break",
      cachePolicy: {
        retention: "short" as const,
        writeMode: "readWrite" as const,
        scope: "session" as const,
        reason: "default" as const,
      },
      dynamicTailParts: ["tail"],
      channelContext: "",
    };
    const baseFingerprint = createProviderRequestFingerprint({
      ...sharedInput,
      stablePrefixParts: ["stable system prompt"],
      toolSchemaSnapshot: createToolSchemaSnapshot([
        { name: "read", description: "Read a file", parameters: { type: "object" } },
      ]),
      payload: { input: "first" },
    });
    const changedFingerprint = createProviderRequestFingerprint({
      ...sharedInput,
      stablePrefixParts: ["different system prompt"],
      toolSchemaSnapshot: createToolSchemaSnapshot([
        { name: "read", description: "Read a file", parameters: { type: "object" } },
        { name: "browser_click", description: "Click an element", parameters: { type: "object" } },
      ]),
      payload: { input: "second" },
    });

    detector.observe({
      source: baseFingerprint.bucketKey,
      fingerprint: baseFingerprint,
      usage: { cacheRead: 10_000, cacheWrite: 500 },
    });
    const observation = detector.observe({
      source: baseFingerprint.bucketKey,
      fingerprint: changedFingerprint,
      usage: { cacheRead: 1_000, cacheWrite: 9_500 },
    });

    expect(observation.reason).toBe("cache_read_drop_exceeded_threshold");
    expect(observation.changedFields).toContain("stablePrefixHash");
  });
});
