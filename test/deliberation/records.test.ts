import { describe, expect, test } from "bun:test";
import {
  MISSING_SELECTION_PROPOSAL_REASON,
  getLatestSkillSelectionRecord,
  listAcceptedContextPacketRecords,
  listInjectableContextPacketRecords,
  resolveSkillSelectionProjection,
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

function buildEvidence(sessionId: string) {
  return [
    {
      id: `${sessionId}:broker-trace`,
      sourceType: "broker_trace" as const,
      locator: "broker://test",
      createdAt: Date.now(),
    },
  ];
}

describe("deliberation proposal record helpers", () => {
  test("resolveSkillSelectionProjection reports skipped when no proposal exists", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("records-none");

    expect(resolveSkillSelectionProjection(runtime, sessionId)).toEqual({
      selection: {
        status: "skipped",
        reason: MISSING_SELECTION_PROPOSAL_REASON,
        selectedCount: 0,
        selectedSkills: [],
      },
      error: null,
    });
  });

  test("resolveSkillSelectionProjection reflects the latest accepted proposal", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("records-selection");

    submitSkillSelectionProposal({
      runtime,
      sessionId,
      issuer: "test.deliberation",
      subject: "review runtime risk",
      selected: [
        {
          name: "review",
          score: 22,
          reason: "best_match",
          breakdown: [],
        },
      ],
      routingOutcome: "selected",
      evidenceRefs: buildEvidence(sessionId),
    });

    const record = getLatestSkillSelectionRecord(runtime, sessionId, "accept");
    expect(record?.proposal.payload.selected[0]?.name).toBe("review");
    expect(resolveSkillSelectionProjection(runtime, sessionId)).toEqual({
      selection: {
        status: "selected",
        reason: "skill_selection_committed",
        selectedCount: 1,
        selectedSkills: ["review"],
      },
      error: null,
    });
  });

  test("listAcceptedContextPacketRecords filters boundary records by accepted decision", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("records-context");

    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo",
      label: "OperatorMemo",
      content: "Prefer evidence-backed planning.",
      evidenceRefs: buildEvidence(sessionId),
    });

    const accepted = listAcceptedContextPacketRecords(runtime, sessionId);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.proposal.payload.label).toBe("OperatorMemo");
    expect(accepted[0]?.receipt.decision).toBe("accept");
  });

  test("listInjectableContextPacketRecords keeps the latest packet per key and scope", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("records-context-effective");

    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo",
      label: "OperatorMemo",
      content: "Older summary",
      packetKey: "summary",
      scopeId: "leaf-a",
      createdAt: 100,
      evidenceRefs: buildEvidence(sessionId),
    });
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo",
      label: "OperatorMemo",
      content: "Newer summary",
      packetKey: "summary",
      scopeId: "leaf-a",
      createdAt: 200,
      evidenceRefs: buildEvidence(sessionId),
    });
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo",
      label: "OperatorMemo",
      content: "Other scope summary",
      packetKey: "summary",
      scopeId: "leaf-b",
      createdAt: 300,
      evidenceRefs: buildEvidence(sessionId),
    });

    const effective = listInjectableContextPacketRecords(runtime, sessionId, {
      injectionScopeId: "leaf-a",
      now: 1_000,
    });
    expect(effective).toHaveLength(1);
    expect(effective[0]?.proposal.payload.content).toBe("Newer summary");
  });

  test("listInjectableContextPacketRecords treats revoke packets as latest-wins tombstones", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = uniqueSessionId("records-context-revoke");

    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo",
      label: "OperatorMemo",
      content: "Active summary",
      packetKey: "summary",
      createdAt: 100,
      expiresAt: 1_000,
      evidenceRefs: buildEvidence(sessionId),
    });
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "operator memo revoked",
      label: "OperatorMemo",
      content: "",
      packetKey: "summary",
      action: "revoke",
      createdAt: 200,
      expiresAt: 1_000,
      evidenceRefs: buildEvidence(sessionId),
    });

    const effective = listInjectableContextPacketRecords(runtime, sessionId, {
      now: 500,
    });
    expect(effective).toHaveLength(0);
  });

  test("listInjectableContextPacketRecords enforces latest-wins even if proposal listings arrive oldest first", () => {
    const sessionId = uniqueSessionId("records-context-oldest-first");
    const oldestFirstRuntime = {
      proposals: {
        list() {
          return [
            {
              proposal: {
                id: `${sessionId}:context_packet:100`,
                kind: "context_packet",
                issuer: "test.operator",
                subject: "older packet",
                payload: {
                  label: "OperatorMemo",
                  content: "Older summary",
                  packetKey: "summary",
                },
                evidenceRefs: buildEvidence(sessionId),
                createdAt: 100,
              },
              receipt: {
                proposalId: `${sessionId}:context_packet:100`,
                decision: "accept",
                policyBasis: ["context_packet"],
                reasons: ["context_packet_committed"],
                committedEffects: [],
                evidenceRefs: buildEvidence(sessionId),
                turn: 1,
                timestamp: 100,
              },
            },
            {
              proposal: {
                id: `${sessionId}:context_packet:200`,
                kind: "context_packet",
                issuer: "test.operator",
                subject: "newer packet",
                payload: {
                  label: "OperatorMemo",
                  content: "Newer summary",
                  packetKey: "summary",
                },
                evidenceRefs: buildEvidence(sessionId),
                createdAt: 200,
              },
              receipt: {
                proposalId: `${sessionId}:context_packet:200`,
                decision: "accept",
                policyBasis: ["context_packet"],
                reasons: ["context_packet_committed"],
                committedEffects: [],
                evidenceRefs: buildEvidence(sessionId),
                turn: 2,
                timestamp: 200,
              },
            },
          ];
        },
      },
    } as unknown as BrewvaRuntime;

    const effective = listInjectableContextPacketRecords(oldestFirstRuntime, sessionId, {
      now: 1_000,
    });
    expect(effective).toHaveLength(1);
    expect(effective[0]?.proposal.payload.content).toBe("Newer summary");
  });
});
