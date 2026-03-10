import { describe, expect, test } from "bun:test";
import {
  buildBrokerTraceEvidenceRef,
  revokeContextPacketProposal,
  submitContextPacketProposal,
  submitSkillSelectionProposal,
} from "@brewva/brewva-deliberation";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function uniqueSessionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("deliberation proposal helpers", () => {
  test("submitSkillSelectionProposal commits through the runtime boundary", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("deliberation-selection");
    const { proposal, receipt } = submitSkillSelectionProposal({
      runtime,
      sessionId,
      issuer: "test.deliberation",
      subject: "review architecture risks",
      selected: [
        {
          name: "review",
          score: 24,
          reason: "best_match",
          breakdown: [],
        },
      ],
      evidenceRefs: [
        buildBrokerTraceEvidenceRef({ sessionId, prompt: "review architecture risks" }),
      ],
      routingOutcome: "selected",
      source: "test",
      prompt: "review architecture risks",
      confidence: 1.5,
    });

    expect(proposal.kind).toBe("skill_selection");
    expect(proposal.confidence).toBe(1);
    expect(receipt.decision).toBe("accept");
    expect(
      runtime.proposals.list(sessionId, { kind: "skill_selection", limit: 1 })[0]?.proposal.id,
    ).toBe(proposal.id);
  });

  test("submitContextPacketProposal records non-authoritative context", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("deliberation-context");
    const { proposal, receipt } = submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator summary",
      label: "OperatorSummary",
      content: "Prefer replay-backed evidence over ad-hoc notes.",
      evidenceRefs: [buildBrokerTraceEvidenceRef({ sessionId, prompt: "operator summary" })],
    });

    expect(proposal.kind).toBe("context_packet");
    expect(receipt.decision).toBe("accept");
    expect(runtime.proposals.list(sessionId, { kind: "context_packet", limit: 1 })).toHaveLength(1);
  });

  test("revokeContextPacketProposal records a revoke action without deleting tape history", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("deliberation-context-revoke");

    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator summary",
      label: "OperatorSummary",
      content: "Prefer replay-backed evidence over ad-hoc notes.",
      packetKey: "operator-summary",
      evidenceRefs: [buildBrokerTraceEvidenceRef({ sessionId, prompt: "operator summary" })],
      expiresAt: Date.now() + 60_000,
    });
    const { proposal, receipt } = revokeContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator summary revoked",
      label: "OperatorSummary",
      packetKey: "operator-summary",
      evidenceRefs: [buildBrokerTraceEvidenceRef({ sessionId, prompt: "revoke operator summary" })],
      expiresAt: Date.now() + 60_000,
    });

    expect(proposal.payload.action).toBe("revoke");
    expect(receipt.decision).toBe("accept");
    expect(runtime.proposals.list(sessionId, { kind: "context_packet" })).toHaveLength(2);
  });
});
