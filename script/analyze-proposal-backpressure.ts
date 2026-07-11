#!/usr/bin/env bun
// Proposal-lane backpressure counter (RFC optimizer-last-hop Phase 4). Counts
// UNCONSUMED harness candidates (evaluated but never decided) by age bucket, aged
// from their first evaluation. Demand-gated: only the counter — aging/expiry and
// rejected-candidate mining are gated on it showing a real backlog across
// consecutive report cycles. RDP candidates are intentionally NOT counted (no
// truthful age/consumption model yet; see proposal-backpressure.ts). Derives a
// view; changes nothing.
import { resolve } from "node:path";
import {
  countProposalBacklog,
  readHarnessCandidateLifecycleRecords,
  unconsumedHarnessCandidates,
} from "@brewva/brewva-gateway/harness";

function main(): void {
  const workspaceRoot = resolve(Bun.argv[2] ?? process.cwd());
  // Reuse the canonical ledger reader (schema/torn-tail-safe) rather than
  // re-parsing candidates.jsonl; its records satisfy ProposalLedgerRecord.
  const proposals = unconsumedHarnessCandidates(
    readHarnessCandidateLifecycleRecords(workspaceRoot),
  );
  const backlog = countProposalBacklog({ proposals, nowMs: Date.now() });
  const byAge = backlog.byAge.map((bucket) => `${bucket.label}=${bucket.count}`).join(" ");
  console.log(
    `Proposal-lane backpressure: ${backlog.total} unconsumed harness candidate(s) by age ${byAge} ` +
      "(demand counter only; a backlog aging across consecutive report cycles gates the aging/expiry work).",
  );
}

main();
