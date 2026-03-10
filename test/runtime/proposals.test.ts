import { afterEach, describe, expect, test } from "bun:test";
import { submitContextPacketProposal } from "@brewva/brewva-deliberation";
import { BrewvaRuntime, type ProposalRecord } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function buildEvidence(sessionId: string, createdAt: number) {
  return [
    {
      id: `${sessionId}:operator-note:${createdAt}`,
      sourceType: "operator_note" as const,
      locator: `session://${sessionId}/operator-note/${createdAt}`,
      createdAt,
    },
  ];
}

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
});

describe("runtime proposals API", () => {
  test("lists proposal records newest first by receipt timestamp", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-${crypto.randomUUID()}`;

    Date.now = () => 100;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "first packet",
      label: "OperatorMemo",
      content: "first",
      evidenceRefs: buildEvidence(sessionId, 100),
    });

    Date.now = () => 300;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "third packet",
      label: "OperatorMemo",
      content: "third",
      evidenceRefs: buildEvidence(sessionId, 300),
    });

    Date.now = () => 200;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "second packet",
      label: "OperatorMemo",
      content: "second",
      evidenceRefs: buildEvidence(sessionId, 200),
    });

    const listed = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(listed.map((record) => record.receipt.timestamp)).toEqual([300, 200, 100]);
    expect(listed.map((record) => record.proposal.payload.content)).toEqual([
      "third",
      "second",
      "first",
    ]);
    const latest = runtime.proposals.list(sessionId, {
      kind: "context_packet",
      limit: 1,
    })[0] as ProposalRecord<"context_packet"> | undefined;
    expect(latest?.proposal.payload.content).toBe("third");
  });
});
