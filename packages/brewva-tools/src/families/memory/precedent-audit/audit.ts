import { resolveToolTargetScope } from "../../../runtime-port/target-scope.js";
import type { NormalizedSolutionRecord } from "../solution-record.js";
import {
  classifyDerivativeLink,
  dedupePaths,
  deriveVerdict,
  isActiveDoc,
  linksToSolutionPath,
  loadPeerSolutionRecord,
  looksLikeSamePrecedent,
  materiallyConflictsWithPeerPrecedent,
  pushFinding,
  resolveMaintenanceRecommendation,
  samePath,
  searchForAudit,
} from "./support.js";
import type {
  DerivativeLinkAuditStatus,
  PrecedentAuditFinding,
  PrecedentAuditSummary,
} from "./types.js";

export function auditPrecedentRecord(input: {
  scope: ReturnType<typeof resolveToolTargetScope>;
  record: NormalizedSolutionRecord;
  candidatePath?: string;
  limit?: number;
}): PrecedentAuditSummary {
  const limit = Math.max(1, Math.min(10, input.limit ?? 6));
  const findings: PrecedentAuditFinding[] = [];
  const { stableDocs, peerSolutions, querySummary } = searchForAudit(
    input.scope,
    input.record,
    limit,
  );

  const stableDocRefs = dedupePaths(stableDocs.map((entry) => entry.doc.relativePath));
  const peerSolutionsAll = peerSolutions.filter(
    (entry) => !samePath(entry.doc.relativePath, input.candidatePath),
  );
  const peerSolutionRefs = dedupePaths(peerSolutionsAll.map((entry) => entry.doc.relativePath));

  const qualifyingLinks = input.record.derivativeLinks
    .map((link) => ({
      link,
      resolution: classifyDerivativeLink(link, input.scope),
    }))
    .filter((entry) => entry.resolution.qualifiesForDisplacement);
  const promotionCandidateLinks = input.record.derivativeLinks
    .map((link) => ({
      link,
      resolution: classifyDerivativeLink(link, input.scope),
    }))
    .filter((entry) => entry.link.targetKind === "promotion_candidate");

  let derivativeLinkStatus: DerivativeLinkAuditStatus =
    input.record.status === "active" ? "not_applicable" : "sufficient";

  if (input.record.status !== "active") {
    if (qualifyingLinks.length === 0) {
      derivativeLinkStatus = "insufficient";
      pushFinding(findings, {
        code: "missing_displacement_link",
        severity: "error",
        summary:
          "Stale or superseded precedents must include at least one stable-doc or successor-solution derivative link.",
        refs: [],
      });
    } else if (qualifyingLinks.some((entry) => !entry.resolution.structurallyValid)) {
      derivativeLinkStatus = "insufficient";
      pushFinding(findings, {
        code: "invalid_derivative_ref",
        severity: "error",
        summary:
          "At least one displacement derivative link points outside the canonical stable-doc or solution-record path conventions.",
        refs: qualifyingLinks
          .map((entry) => entry.resolution.relativePath ?? entry.link.ref)
          .filter((entry): entry is string => Boolean(entry)),
      });
    } else if (qualifyingLinks.some((entry) => !entry.resolution.exists)) {
      derivativeLinkStatus = "unresolved";
      pushFinding(findings, {
        code: "unresolved_derivative_ref",
        severity: "warn",
        summary:
          "A displacement derivative link is structurally valid but the referenced successor or stable document is not present yet.",
        refs: qualifyingLinks
          .map((entry) => entry.resolution.relativePath ?? entry.link.ref)
          .filter((entry): entry is string => Boolean(entry)),
      });
    }
  }

  if (promotionCandidateLinks.some((entry) => !entry.resolution.structurallyValid)) {
    pushFinding(findings, {
      code: "invalid_promotion_candidate_ref",
      severity: "error",
      summary:
        "Promotion-candidate derivative links must stay under .brewva/knowledge/ so the related warm-memory artifact remains inspectable.",
      refs: promotionCandidateLinks
        .map((entry) => entry.resolution.relativePath ?? entry.link.ref)
        .filter((entry): entry is string => Boolean(entry)),
    });
  }

  const promotedLink = qualifyingLinks.find(
    (entry) => entry.link.relation === "promoted_to" && entry.link.targetKind === "stable_doc",
  );
  if (input.record.status === "active" && promotedLink) {
    pushFinding(findings, {
      code: "active_promoted_precedent",
      severity: "error",
      summary:
        "An active solution record cannot also declare that a stable document has displaced it. Mark the record stale instead.",
      refs: [promotedLink.resolution.relativePath ?? promotedLink.link.ref],
    });
  }

  const supersededLink = qualifyingLinks.find(
    (entry) =>
      entry.link.relation === "superseded_by" && entry.link.targetKind === "solution_record",
  );
  if (input.record.status === "active" && supersededLink) {
    pushFinding(findings, {
      code: "active_superseded_precedent",
      severity: "error",
      summary:
        "An active solution record cannot also declare that a successor precedent superseded it. Mark the record superseded instead.",
      refs: [supersededLink.resolution.relativePath ?? supersededLink.link.ref],
    });
  }

  if (stableDocRefs.length > 0 && input.record.status === "active") {
    pushFinding(findings, {
      code: "higher_authority_overlap",
      severity: "warn",
      summary:
        "Higher-authority stable documentation overlaps this precedent query. Review whether the active solution record should remain active or move into maintenance.",
      refs: stableDocRefs,
    });
  }

  const likelyDuplicates = peerSolutionsAll.filter(
    (entry) =>
      isActiveDoc(entry) && looksLikeSamePrecedent(input.record, entry, input.candidatePath),
  );
  if (likelyDuplicates.length > 0) {
    pushFinding(findings, {
      code: "potential_duplicate_precedent",
      severity: "warn",
      summary:
        "A likely active solution precedent already exists for this failure class. Prefer updating the canonical record instead of creating a sibling duplicate.",
      refs: dedupePaths(likelyDuplicates.map((entry) => entry.doc.relativePath)),
    });
  }

  const sameRankConflicts = likelyDuplicates.filter((entry) => {
    const peerRecord = loadPeerSolutionRecord(entry);
    if (!peerRecord) {
      return false;
    }
    const linkedFromCandidate = linksToSolutionPath(input.record, entry.doc.relativePath);
    const linkedFromPeer = linksToSolutionPath(peerRecord, input.candidatePath);
    if (linkedFromCandidate || linkedFromPeer) {
      return false;
    }
    return materiallyConflictsWithPeerPrecedent({
      record: input.record,
      peerRecord,
    });
  });
  if (sameRankConflicts.length > 0) {
    pushFinding(findings, {
      code: "same_rank_conflict",
      severity: "warn",
      summary:
        "At least one active peer solution record conflicts with this active precedent at the same authority rank. Resolve the conflict explicitly instead of relying on recency.",
      refs: dedupePaths(sameRankConflicts.map((entry) => entry.doc.relativePath)),
    });
  }

  const consultedRefs = dedupePaths([...stableDocRefs, ...peerSolutionRefs])
    .slice(0, limit)
    .map((path) => {
      const doc =
        stableDocs.find((entry) => entry.doc.relativePath === path) ??
        peerSolutionsAll.find((entry) => entry.doc.relativePath === path);
      return {
        path,
        sourceType: doc?.doc.sourceType ?? "solution",
        authorityRank: doc?.authorityRank ?? 0,
        freshness: doc?.doc.freshness ?? "unknown",
      };
    });

  return {
    verdict: deriveVerdict(findings),
    maintenanceRecommendation: resolveMaintenanceRecommendation({ findings }),
    derivativeLinkStatus,
    querySummary,
    ...(input.candidatePath ? { candidatePath: input.candidatePath } : {}),
    stableDocRefs,
    peerSolutionRefs,
    consultedRefs,
    findings,
  };
}
