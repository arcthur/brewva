import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function buildEvidenceRef(sessionId: string) {
  return {
    id: `${sessionId}:broker-trace`,
    sourceType: "broker_trace" as const,
    locator: "broker://test",
    createdAt: Date.now(),
  };
}

describe("S-001 proposal boundary", () => {
  test("skill_selection proposals become pending kernel commitments", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-route-1";

    const receipt = runtime.proposals.submit(sessionId, {
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
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getPendingDispatch(sessionId)?.primary?.name).toBe("review");
    expect(runtime.skills.getPendingDispatch(sessionId)?.mode).toBe("auto");
    expect(runtime.proposals.list(sessionId, { kind: "skill_selection", limit: 1 })).toHaveLength(
      1,
    );
  });

  test("missing evidence rejects the proposal at the boundary", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-route-missing-evidence";

    const receipt = runtime.proposals.submit(sessionId, {
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
      evidenceRefs: [],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("reject");
    expect(receipt.reasons).toContain("proposal_missing_evidence");
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
  });

  test("empty selection proposals defer instead of fabricating kernel routing", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-route-empty";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:selection`,
      kind: "skill_selection",
      issuer: "test.broker",
      subject: "review architecture risks",
      payload: {
        selected: [],
        routingOutcome: "failed",
      },
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("defer");
    expect(receipt.reasons).toContain("selection_failed_without_commitment");
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
  });

  test("context_packet proposals are admitted without mutating kernel state directly", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-context-packet";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context`,
      kind: "context_packet",
      issuer: "test.operator",
      subject: "operator context",
      payload: {
        label: "OperatorMemo",
        content: "Prefer evidence-backed review findings.",
      },
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("accept");
    expect(runtime.proposals.list(sessionId, { kind: "context_packet", limit: 1 })).toHaveLength(1);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
  });

  test("reserved issuers cannot submit disallowed proposal kinds", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-reserved-issuer";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context`,
      kind: "context_packet",
      issuer: "brewva.skill-broker",
      subject: "broker context",
      payload: {
        label: "BrokerMemo",
        content: "This should not be allowed.",
      },
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("reject");
    expect(receipt.reasons).toContain(
      "reserved_issuer_kind_disallowed:brewva.skill-broker:context_packet",
    );
  });

  test("reserved debug-loop context packets require scoped status-summary policy fields", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "proposal-debug-loop-policy";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:context`,
      kind: "context_packet",
      issuer: "brewva.extensions.debug-loop",
      subject: "debug loop status",
      payload: {
        label: "DebugLoopStatus",
        content: "[StatusSummary]\nprofile: status_summary",
        packetKey: "debug-loop:status",
      },
      evidenceRefs: [
        {
          id: `${sessionId}:event`,
          sourceType: "event",
          locator: "event://verification",
          createdAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
    });

    expect(receipt.decision).toBe("reject");
    expect(receipt.reasons).toContain(
      "reserved_context_packet_missing_scope:brewva.extensions.debug-loop",
    );
  });
});
