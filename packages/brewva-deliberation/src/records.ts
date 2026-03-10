import type {
  BrewvaRuntime,
  ProposalDecision,
  ProposalKind,
  ProposalRecord,
  SkillRoutingOutcome,
} from "@brewva/brewva-runtime";

type ProposalQueryRuntime = Pick<BrewvaRuntime, "proposals">;

export const MISSING_SELECTION_PROPOSAL_REASON = "selection_proposal_unavailable";

export interface SkillSelectionProjection {
  selection: {
    status: SkillRoutingOutcome | "skipped";
    reason: string;
    selectedCount: number;
    selectedSkills: string[];
  };
  error: string | null;
}

function compareProposalRecordsNewestFirst<K extends ProposalKind>(
  left: ProposalRecord<K>,
  right: ProposalRecord<K>,
): number {
  if (right.receipt.timestamp !== left.receipt.timestamp) {
    return right.receipt.timestamp - left.receipt.timestamp;
  }
  if (right.proposal.createdAt !== left.proposal.createdAt) {
    return right.proposal.createdAt - left.proposal.createdAt;
  }
  return right.proposal.id.localeCompare(left.proposal.id);
}

export function getLatestProposalRecord<K extends ProposalKind>(input: {
  runtime: ProposalQueryRuntime;
  sessionId: string;
  kind: K;
  decision?: ProposalDecision;
}): ProposalRecord<K> | undefined {
  return input.runtime.proposals.list(input.sessionId, {
    kind: input.kind,
    decision: input.decision,
    limit: 1,
  })[0] as ProposalRecord<K> | undefined;
}

export function getLatestSkillSelectionRecord(
  runtime: ProposalQueryRuntime,
  sessionId: string,
  decision?: ProposalDecision,
): ProposalRecord<"skill_selection"> | undefined {
  return getLatestProposalRecord({
    runtime,
    sessionId,
    kind: "skill_selection",
    decision,
  });
}

export function listAcceptedContextPacketRecords(
  runtime: ProposalQueryRuntime,
  sessionId: string,
): ProposalRecord<"context_packet">[] {
  return runtime.proposals.list(sessionId, {
    kind: "context_packet",
    decision: "accept",
  }) as ProposalRecord<"context_packet">[];
}

export function listInjectableContextPacketRecords(
  runtime: ProposalQueryRuntime,
  sessionId: string,
  input: {
    injectionScopeId?: string;
    now?: number;
  } = {},
): ProposalRecord<"context_packet">[] {
  const now = input.now ?? Date.now();
  const seenKeys = new Set<string>();
  const records = listAcceptedContextPacketRecords(runtime, sessionId).toSorted(
    compareProposalRecordsNewestFirst,
  );
  const effective: ProposalRecord<"context_packet">[] = [];

  for (const record of records) {
    const scopeId = record.proposal.payload.scopeId;
    const action = record.proposal.payload.action ?? "upsert";
    if (scopeId && scopeId !== input.injectionScopeId) {
      continue;
    }
    if (typeof record.proposal.expiresAt === "number" && record.proposal.expiresAt < now) {
      continue;
    }
    const packetKey = record.proposal.payload.packetKey?.trim();
    if (packetKey) {
      const dedupeKey = `${record.proposal.issuer}:${scopeId ?? "global"}:${packetKey}`;
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);
      if (action === "revoke") {
        continue;
      }
    }
    if (action === "revoke") {
      continue;
    }
    effective.push(record);
  }

  return effective;
}

export function resolveSkillSelectionProjection(
  runtime: ProposalQueryRuntime,
  sessionId: string,
): SkillSelectionProjection {
  const record = getLatestSkillSelectionRecord(runtime, sessionId);
  if (!record) {
    return {
      selection: {
        status: "skipped",
        reason: MISSING_SELECTION_PROPOSAL_REASON,
        selectedCount: 0,
        selectedSkills: [],
      },
      error: null,
    };
  }

  const selected = record.proposal.payload.selected;
  if (record.receipt.decision !== "accept") {
    const reason = record.receipt.reasons.join(", ") || "selection_not_committed";
    return {
      selection: {
        status: "failed",
        reason,
        selectedCount: 0,
        selectedSkills: [],
      },
      error: reason,
    };
  }

  return {
    selection: {
      status: selected.length > 0 ? "selected" : "empty",
      reason: record.receipt.reasons.join(", ") || "selection_committed",
      selectedCount: selected.length,
      selectedSkills: selected.map((entry) => entry.name),
    },
    error: null,
  };
}
