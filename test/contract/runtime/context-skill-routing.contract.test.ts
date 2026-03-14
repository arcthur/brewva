import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("context skill routing", () => {
  test("accepted skill_selection proposals inject skill candidates for strong prompts", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;
    config.skills.routing.enabled = true;

    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("ctx-skill-routing"),
      config,
    });
    const sessionId = "ctx-skill-routing-1";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:selection`,
      kind: "skill_selection",
      issuer: "test.broker",
      subject: "review architecture risks",
      payload: {
        selected: [
          {
            name: "review",
            score: 24,
            reason: "test_selection",
            breakdown: [],
          },
        ],
        routingOutcome: "selected",
      },
      confidence: 0.9,
      evidenceRefs: [
        {
          id: `${sessionId}:broker-trace`,
          sourceType: "broker_trace",
          locator: "broker://test",
          createdAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Review architecture risks, merge safety, and quality audit gaps in this project",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-a",
    );

    expect(injection.accepted).toBe(true);
    expect(injection.text).toContain("Top-K Skill Candidates:");
    expect(injection.text).toContain("review");

    const routed = runtime.events.query(sessionId, { type: "skill_routing_decided", last: 1 })[0];
    expect(routed).toBeDefined();
    const payload = routed?.payload as { mode?: string; selectedCount?: number } | undefined;
    expect(payload?.mode).toBe("auto");
    expect(payload?.selectedCount).toBeGreaterThan(0);
  });

  test("without a proposal the kernel does not fabricate skill candidates", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;
    config.skills.routing.enabled = true;

    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("ctx-skill-routing-low-confidence"),
      config,
    });
    const sessionId = "ctx-skill-routing-2";
    runtime.context.onTurnStart(sessionId, 1);

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Can you plan?",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-b",
    );

    expect(injection.accepted).toBe(true);
    expect(injection.text).not.toContain("Top-K Skill Candidates:");
    expect(runtime.events.query(sessionId, { type: "skill_routing_decided" })).toHaveLength(0);
  });

  test("context packets inject only the latest active packet for the matching scope", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("ctx-context-packets"),
      config,
    });
    const sessionId = "ctx-context-packets-1";
    runtime.context.onTurnStart(sessionId, 1);

    const evidenceRefs = [
      {
        id: `${sessionId}:operator-note`,
        sourceType: "operator_note" as const,
        locator: "session://test/context-packet",
        createdAt: Date.now(),
      },
    ];

    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:1`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "leaf-a summary",
      payload: {
        label: "OperatorMemo",
        content: "Older leaf-a summary",
        scopeId: "leaf-a",
        packetKey: "summary",
      },
      evidenceRefs,
      createdAt: 100,
    });
    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:2`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "leaf-a summary",
      payload: {
        label: "OperatorMemo",
        content: "Newer leaf-a summary",
        scopeId: "leaf-a",
        packetKey: "summary",
      },
      evidenceRefs,
      createdAt: 200,
    });
    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:3`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "leaf-b summary",
      payload: {
        label: "OperatorMemo",
        content: "Leaf-b summary",
        scopeId: "leaf-b",
        packetKey: "summary",
      },
      evidenceRefs,
      createdAt: 300,
    });

    const leafAInjection = await runtime.context.buildInjection(
      sessionId,
      "Continue with the current task",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-a",
    );
    expect(leafAInjection.text).toContain("Newer leaf-a summary");
    expect(leafAInjection.text).not.toContain("Older leaf-a summary");
    expect(leafAInjection.text).not.toContain("Leaf-b summary");

    const leafBInjection = await runtime.context.buildInjection(
      sessionId,
      "Continue with the current task",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-b",
    );
    expect(leafBInjection.text).toContain("Leaf-b summary");
    expect(leafBInjection.text).not.toContain("Newer leaf-a summary");
  });

  test("expired context packets stop injecting after their ttl elapses", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("ctx-context-packets-expired"),
      config,
    });
    const sessionId = "ctx-context-packets-2";
    runtime.context.onTurnStart(sessionId, 1);
    const createdAt = Date.now();
    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:ttl`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "temporary memo",
      payload: {
        label: "TemporaryMemo",
        content: "This summary should expire.",
        packetKey: "temporary",
      },
      evidenceRefs: [
        {
          id: `${sessionId}:operator-note`,
          sourceType: "operator_note",
          locator: "session://test/context-packet",
          createdAt,
        },
      ],
      createdAt,
      expiresAt: createdAt + 10,
    });

    const originalNow = Date.now;
    Date.now = () => createdAt + 20;

    try {
      const injection = await runtime.context.buildInjection(
        sessionId,
        "Continue with the current task",
        { tokens: 640, contextWindow: 4096, percent: 0.16 },
        "leaf-a",
      );
      expect(injection.text).not.toContain("This summary should expire.");
    } finally {
      Date.now = originalNow;
    }
  });

  test("context packet revoke removes the latest packet from injection without erasing tape history", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("ctx-context-packets-revoke"),
      config,
    });
    const sessionId = "ctx-context-packets-3";
    runtime.context.onTurnStart(sessionId, 1);
    const createdAt = Date.now();
    const evidenceRefs = [
      {
        id: `${sessionId}:operator-note`,
        sourceType: "operator_note" as const,
        locator: "session://test/context-packet",
        createdAt,
      },
    ];

    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:upsert`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "temporary memo",
      payload: {
        label: "TemporaryMemo",
        content: "This summary should be revoked.",
        packetKey: "temporary",
      },
      evidenceRefs,
      createdAt,
      expiresAt: createdAt + 60_000,
    });
    runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context:revoke`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "temporary memo revoked",
      payload: {
        label: "TemporaryMemo",
        content: "",
        packetKey: "temporary",
        action: "revoke",
      },
      evidenceRefs,
      createdAt: createdAt + 1,
      expiresAt: createdAt + 60_000,
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Continue with the current task",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-a",
    );

    expect(injection.text).not.toContain("This summary should be revoked.");
    expect(runtime.proposals.list(sessionId, { kind: "context_packet" })).toHaveLength(2);
  });

  test("context packets survive runtime restart and rehydrate the latest active packet", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const workspace = createTestWorkspace("ctx-context-packets-rehydrate");
    const sessionId = "ctx-context-packets-4";
    const createdAt = Date.now();
    const evidenceRefs = [
      {
        id: `${sessionId}:operator-note`,
        sourceType: "operator_note" as const,
        locator: "session://test/context-packet",
        createdAt,
      },
    ];

    const writerRuntime = new BrewvaRuntime({
      cwd: workspace,
      config,
    });
    writerRuntime.context.onTurnStart(sessionId, 1);
    writerRuntime.proposals.submit(sessionId, {
      id: `${sessionId}:context:old`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "restart memo",
      payload: {
        label: "OperatorMemo",
        content: "Old restart summary",
        scopeId: "leaf-a",
        packetKey: "summary",
      },
      evidenceRefs,
      createdAt,
    });
    writerRuntime.proposals.submit(sessionId, {
      id: `${sessionId}:context:new`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "restart memo",
      payload: {
        label: "OperatorMemo",
        content: "Fresh restart summary",
        scopeId: "leaf-a",
        packetKey: "summary",
      },
      evidenceRefs,
      createdAt: createdAt + 1,
    });

    const readerRuntime = new BrewvaRuntime({
      cwd: workspace,
      config,
    });
    readerRuntime.context.onTurnStart(sessionId, 1);

    const injection = await readerRuntime.context.buildInjection(
      sessionId,
      "Continue with the current task",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-a",
    );

    expect(injection.text).toContain("Fresh restart summary");
    expect(injection.text).not.toContain("Old restart summary");
  });
});
