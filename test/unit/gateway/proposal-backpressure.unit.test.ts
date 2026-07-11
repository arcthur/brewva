import { describe, expect, test } from "bun:test";
import { countProposalBacklog, unconsumedHarnessCandidates } from "@brewva/brewva-gateway/harness";

const NOW = Date.parse("2026-07-11T00:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();
const bySlug = (left: { id: string }, right: { id: string }): number =>
  left.id.localeCompare(right.id);

describe("proposal-lane backpressure counter", () => {
  test("a harness candidate is unconsumed until a decision receipt lands", () => {
    const proposals = unconsumedHarnessCandidates([
      { action: "evaluated", candidateId: "a", at: daysAgo(5) },
      { action: "evaluated", candidateId: "a", at: daysAgo(2) }, // re-eval; EARLIEST wins
      { action: "evaluated", candidateId: "b", at: daysAgo(10) },
      { action: "rejected", candidateId: "b", at: daysAgo(1) }, // b decided -> consumed
      { action: "evaluated", candidateId: "c", at: daysAgo(40) },
    ]);
    expect(proposals.toSorted(bySlug).map((proposal) => proposal.id)).toEqual(["a", "c"]);
    // Age is the FIRST evaluation (how long undecided), not the latest re-eval.
    expect(proposals.find((proposal) => proposal.id === "a")?.at).toBe(daysAgo(5));
  });

  test("counts by age bucket and total", () => {
    const backlog = countProposalBacklog({
      nowMs: NOW,
      proposals: [
        { id: "a", at: daysAgo(3) },
        { id: "c", at: daysAgo(40) },
        { id: "d", at: daysAgo(15) },
      ],
    });
    expect(backlog.total).toBe(3);
    expect(backlog.byAge).toEqual([
      { label: "<7d", count: 1 },
      { label: "7-30d", count: 1 },
      { label: ">30d", count: 1 },
    ]);
  });

  test("an unparseable/absent timestamp surfaces in the oldest bucket, never dropped", () => {
    const backlog = countProposalBacklog({
      nowMs: NOW,
      proposals: [{ id: "no-date", at: "" }],
    });
    expect(backlog.total).toBe(1);
    expect(backlog.byAge).toEqual([
      { label: "<7d", count: 0 },
      { label: "7-30d", count: 0 },
      { label: ">30d", count: 1 },
    ]);
  });

  test("an empty backlog counts zero across all buckets", () => {
    const backlog = countProposalBacklog({ nowMs: NOW, proposals: [] });
    expect(backlog.total).toBe(0);
    expect(backlog.byAge.map((bucket) => bucket.count)).toEqual([0, 0, 0]);
  });
});
