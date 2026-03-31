import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  executeKnowledgeSearch,
  type ExecutedKnowledgeSearch,
  type KnowledgeSourceType,
  type ScoredKnowledgeDoc,
} from "./knowledge-search-core.js";
import {
  type DerivativeLink,
  type NormalizedSolutionRecord,
  parseSolutionDocument,
  SolutionRecordInputSchema,
  normalizeRelativePath,
  normalizeSolutionRecord,
  validateSolutionRecord,
} from "./solution-record.js";
import { isPathInsideRoots, resolveScopedPath, resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const DISPLACEMENT_TARGET_KINDS = new Set(["stable_doc", "solution_record"] as const);
const STABLE_DOC_PREFIXES = ["docs/architecture/", "docs/reference/"] as const;
const SOLUTION_DOC_PREFIX = "docs/solutions/";
const PROMOTION_CANDIDATE_PREFIXES = [
  ".brewva/skill-broker/materialized/",
  ".brewva/skill-broker/",
] as const;

export type PrecedentAuditVerdict = "pass" | "inconclusive" | "fail";
export type DerivativeLinkAuditStatus =
  | "not_applicable"
  | "sufficient"
  | "insufficient"
  | "unresolved";
export type PrecedentMaintenanceRecommendation =
  | "none"
  | "review_for_drift"
  | "mark_stale"
  | "mark_superseded"
  | "complete_derivative_routing";
export type PrecedentAuditFindingSeverity = "info" | "warn" | "error";

export interface PrecedentAuditFinding {
  code: string;
  severity: PrecedentAuditFindingSeverity;
  summary: string;
  refs: string[];
}

export interface PrecedentAuditSummary {
  verdict: PrecedentAuditVerdict;
  maintenanceRecommendation: PrecedentMaintenanceRecommendation;
  derivativeLinkStatus: DerivativeLinkAuditStatus;
  querySummary: string;
  candidatePath?: string;
  stableDocRefs: string[];
  peerSolutionRefs: string[];
  consultedRefs: Array<{
    path: string;
    sourceType: KnowledgeSourceType;
    authorityRank: number;
    freshness: string;
  }>;
  findings: PrecedentAuditFinding[];
}

interface LoadedAuditCandidate {
  record: NormalizedSolutionRecord;
  candidatePath?: string;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePathRef(
  ref: string,
  scope: ReturnType<typeof resolveToolTargetScope>,
): {
  relativePath?: string;
  exists: boolean;
  insidePrimaryRoot: boolean;
} {
  const absolutePath = resolveScopedPath(ref, scope);
  if (!absolutePath) {
    return {
      exists: false,
      insidePrimaryRoot: false,
    };
  }
  const insidePrimaryRoot = isPathInsideRoots(absolutePath, [scope.primaryRoot]);
  if (!insidePrimaryRoot) {
    return {
      exists: false,
      insidePrimaryRoot: false,
    };
  }
  return {
    relativePath: normalizeRelativePath(relative(scope.primaryRoot, absolutePath)),
    exists: existsSync(absolutePath),
    insidePrimaryRoot: true,
  };
}

function deriveAuditQuery(record: NormalizedSolutionRecord): string {
  return [
    record.title,
    record.problemKind,
    record.module,
    ...record.tags.slice(0, 2),
    ...record.boundaries.slice(0, 1),
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join(" ");
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return normalizeRelativePath(left) === normalizeRelativePath(right);
}

function isActiveDoc(entry: ScoredKnowledgeDoc): boolean {
  return (entry.doc.status ?? "active").toLowerCase() === "active";
}

function looksLikeSamePrecedent(
  record: NormalizedSolutionRecord,
  entry: ScoredKnowledgeDoc,
  candidatePath: string | undefined,
): boolean {
  if (samePath(entry.doc.relativePath, candidatePath)) {
    return false;
  }
  if (entry.doc.title.trim().toLowerCase() === record.title.trim().toLowerCase()) {
    return true;
  }
  if (
    record.module &&
    entry.doc.module &&
    record.module.toLowerCase() === entry.doc.module.toLowerCase() &&
    record.problemKind.toLowerCase() === (entry.doc.problemKind ?? "").toLowerCase()
  ) {
    const boundaryOverlap = record.boundaries.some((boundary) =>
      entry.doc.boundaries.some(
        (docBoundary) => docBoundary.toLowerCase() === boundary.toLowerCase(),
      ),
    );
    const tagOverlap = record.tags.some((tag) =>
      entry.doc.tags.some((docTag) => docTag.toLowerCase() === tag.toLowerCase()),
    );
    return boundaryOverlap || tagOverlap;
  }
  return false;
}

function findSectionBody(
  record: NormalizedSolutionRecord,
  headings: readonly string[],
): string | undefined {
  const lowered = new Set(headings.map((heading) => heading.toLowerCase()));
  const section = record.sections.find((entry) => lowered.has(entry.heading.toLowerCase()));
  return section?.body;
}

function fingerprintBody(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDerivativeRef(ref: string): string {
  return normalizeRelativePath(ref.trim());
}

function linksToSolutionPath(
  record: NormalizedSolutionRecord,
  solutionPath: string | undefined,
): boolean {
  if (!solutionPath) {
    return false;
  }
  const normalizedPath = normalizeRelativePath(solutionPath);
  return record.derivativeLinks.some((link) => normalizeDerivativeRef(link.ref) === normalizedPath);
}

function loadPeerSolutionRecord(entry: ScoredKnowledgeDoc): NormalizedSolutionRecord | undefined {
  try {
    return parseSolutionDocument(readFileSync(entry.doc.absolutePath, "utf8")).record;
  } catch {
    return undefined;
  }
}

function materiallyConflictsWithPeerPrecedent(input: {
  record: NormalizedSolutionRecord;
  peerRecord: NormalizedSolutionRecord;
}): boolean {
  const recordGuidance = fingerprintBody(
    findSectionBody(input.record, ["Guidance", "Solution", "Why This Works", "Context"]),
  );
  const peerGuidance = fingerprintBody(
    findSectionBody(input.peerRecord, ["Guidance", "Solution", "Why This Works", "Context"]),
  );
  if (!recordGuidance || !peerGuidance) {
    return input.record.title.trim().toLowerCase() !== input.peerRecord.title.trim().toLowerCase();
  }
  return recordGuidance !== peerGuidance;
}

function dedupePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeRelativePath(value)))];
}

function pushFinding(
  findings: PrecedentAuditFinding[],
  finding: PrecedentAuditFinding,
): PrecedentAuditFinding[] {
  if (findings.some((entry) => entry.code === finding.code && entry.summary === finding.summary)) {
    return findings;
  }
  findings.push(finding);
  return findings;
}

function classifyDerivativeLink(
  link: DerivativeLink,
  scope: ReturnType<typeof resolveToolTargetScope>,
): {
  qualifiesForDisplacement: boolean;
  relativePath?: string;
  structurallyValid: boolean;
  exists: boolean;
} {
  const resolved = normalizePathRef(link.ref, scope);
  const relativePath = resolved.relativePath;
  if (link.targetKind === "stable_doc") {
    const structurallyValid = Boolean(
      relativePath &&
      STABLE_DOC_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) &&
      relativePath.endsWith(".md"),
    );
    return {
      qualifiesForDisplacement: DISPLACEMENT_TARGET_KINDS.has(link.targetKind),
      relativePath,
      structurallyValid,
      exists: structurallyValid && resolved.exists,
    };
  }
  if (link.targetKind === "solution_record") {
    const structurallyValid = Boolean(
      relativePath && relativePath.startsWith(SOLUTION_DOC_PREFIX) && relativePath.endsWith(".md"),
    );
    return {
      qualifiesForDisplacement: DISPLACEMENT_TARGET_KINDS.has(link.targetKind),
      relativePath,
      structurallyValid,
      exists: structurallyValid && resolved.exists,
    };
  }
  if (link.targetKind === "promotion_candidate") {
    const structurallyValid = Boolean(
      relativePath &&
      PROMOTION_CANDIDATE_PREFIXES.some((prefix) => relativePath.startsWith(prefix)),
    );
    return {
      qualifiesForDisplacement: false,
      relativePath,
      structurallyValid,
      exists: structurallyValid && resolved.exists,
    };
  }
  return {
    qualifiesForDisplacement: false,
    relativePath,
    structurallyValid: Boolean(relativePath),
    exists: resolved.exists,
  };
}

function searchForAudit(
  scope: ReturnType<typeof resolveToolTargetScope>,
  record: NormalizedSolutionRecord,
  limit: number,
): {
  stableDocs: ExecutedKnowledgeSearch["results"];
  peerSolutions: ExecutedKnowledgeSearch["results"];
  querySummary: string;
} {
  const query = deriveAuditQuery(record);
  const boundary = record.boundaries[0];
  const stableDocs = executeKnowledgeSearch(scope.allowedRoots, {
    query,
    queryIntent: "normative_lookup",
    sourceTypes: ["stable_doc"],
    ...(record.module ? { module: record.module } : {}),
    ...(boundary ? { boundary } : {}),
    ...(record.tags.length > 0 ? { tags: record.tags.slice(0, 3) } : {}),
    limit,
  });
  const peerSolutions = executeKnowledgeSearch(scope.allowedRoots, {
    query,
    queryIntent: "precedent_lookup",
    sourceTypes: ["solution"],
    ...(record.module ? { module: record.module } : {}),
    ...(boundary ? { boundary } : {}),
    ...(record.tags.length > 0 ? { tags: record.tags.slice(0, 3) } : {}),
    ...(record.problemKind ? { problemKind: record.problemKind } : {}),
    limit,
  });
  return {
    stableDocs: stableDocs.results,
    peerSolutions: peerSolutions.results,
    querySummary: [
      `normative_consult{${stableDocs.querySummary}}`,
      `precedent_consult{${peerSolutions.querySummary}}`,
    ].join(" || "),
  };
}

function resolveMaintenanceRecommendation(input: {
  findings: readonly PrecedentAuditFinding[];
  record: NormalizedSolutionRecord;
}): PrecedentMaintenanceRecommendation {
  if (input.findings.some((finding) => finding.code === "active_promoted_precedent")) {
    return "mark_stale";
  }
  if (input.findings.some((finding) => finding.code === "active_superseded_precedent")) {
    return "mark_superseded";
  }
  if (
    input.findings.some(
      (finding) =>
        finding.code === "missing_displacement_link" ||
        finding.code === "invalid_derivative_ref" ||
        finding.code === "invalid_promotion_candidate_ref",
    )
  ) {
    return "complete_derivative_routing";
  }
  if (
    input.findings.some(
      (finding) =>
        finding.code === "higher_authority_overlap" ||
        finding.code === "same_rank_conflict" ||
        finding.code === "potential_duplicate_precedent" ||
        finding.code === "unresolved_derivative_ref",
    )
  ) {
    return "review_for_drift";
  }
  return "none";
}

function deriveVerdict(findings: readonly PrecedentAuditFinding[]): PrecedentAuditVerdict {
  if (findings.some((finding) => finding.severity === "error")) {
    return "fail";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "inconclusive";
  }
  return "pass";
}

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
        "Promotion-candidate derivative links must stay under .brewva/skill-broker/ so the related warm-memory artifact remains inspectable.",
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
    maintenanceRecommendation: resolveMaintenanceRecommendation({
      findings,
      record: input.record,
    }),
    derivativeLinkStatus,
    querySummary,
    ...(input.candidatePath ? { candidatePath: input.candidatePath } : {}),
    stableDocRefs,
    peerSolutionRefs,
    consultedRefs,
    findings,
  };
}

function formatAuditText(summary: PrecedentAuditSummary): string {
  const lines = [
    "# Precedent Audit",
    `verdict: ${summary.verdict}`,
    `maintenance_recommendation: ${summary.maintenanceRecommendation}`,
    `derivative_link_status: ${summary.derivativeLinkStatus}`,
    `query_summary: ${summary.querySummary}`,
  ];
  if (summary.candidatePath) {
    lines.push(`candidate_path: ${summary.candidatePath}`);
  }
  lines.push(`consulted_refs: ${summary.consultedRefs.length}`);
  if (summary.stableDocRefs.length > 0) {
    lines.push(`stable_doc_refs: ${summary.stableDocRefs.join(", ")}`);
  }
  if (summary.peerSolutionRefs.length > 0) {
    lines.push(`peer_solution_refs: ${summary.peerSolutionRefs.join(", ")}`);
  }
  if (summary.findings.length > 0) {
    lines.push("findings:");
    for (const finding of summary.findings) {
      const refs = finding.refs.length > 0 ? ` [${finding.refs.join(", ")}]` : "";
      lines.push(`- ${finding.severity} ${finding.code}: ${finding.summary}${refs}`);
    }
  }
  return lines.join("\n");
}

function loadAuditCandidate(input: {
  scope: ReturnType<typeof resolveToolTargetScope>;
  requestedPath?: string;
  rawRecord?: unknown;
}):
  | {
      ok: true;
      candidate: LoadedAuditCandidate;
    }
  | {
      ok: false;
      message: string;
      details: Record<string, unknown>;
    } {
  const requestedPath = readTrimmedString(input.requestedPath);
  const hasRecord = Boolean(input.rawRecord && typeof input.rawRecord === "object");

  if (!requestedPath && !hasRecord) {
    return {
      ok: false,
      message: "precedent_audit requires solution_doc_path, solution_record, or both.",
      details: {
        error: "missing_audit_target",
      },
    };
  }

  if (requestedPath && !hasRecord) {
    const absolutePath = resolveScopedPath(requestedPath, input.scope);
    if (!absolutePath || !isPathInsideRoots(absolutePath, [input.scope.primaryRoot])) {
      return {
        ok: false,
        message: "precedent_audit path must stay inside the primary target root.",
        details: {
          error: "invalid_solution_doc_path",
          requestedPath,
        },
      };
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      return {
        ok: false,
        message: "precedent_audit target solution document does not exist.",
        details: {
          error: "missing_solution_doc",
          requestedPath,
        },
      };
    }
    const relativePath = normalizeRelativePath(relative(input.scope.primaryRoot, absolutePath));
    if (!relativePath.startsWith(SOLUTION_DOC_PREFIX) || !relativePath.endsWith(".md")) {
      return {
        ok: false,
        message: "precedent_audit only accepts solution documents under docs/solutions/.",
        details: {
          error: "invalid_solution_doc_path",
          requestedPath: relativePath,
        },
      };
    }
    const parsed = parseSolutionDocument(readFileSync(absolutePath, "utf8"));
    const problems = validateSolutionRecord(parsed.record);
    if (problems.length > 0) {
      return {
        ok: false,
        message: problems.join("\n"),
        details: {
          error: "invalid_solution_record",
          validationProblems: problems,
          solutionDocPath: relativePath,
        },
      };
    }
    return {
      ok: true,
      candidate: {
        record: parsed.record,
        candidatePath: relativePath,
      },
    };
  }

  const record = normalizeSolutionRecord(
    input.rawRecord as Parameters<typeof normalizeSolutionRecord>[0],
  );
  const problems = validateSolutionRecord(record);
  if (problems.length > 0) {
    return {
      ok: false,
      message: problems.join("\n"),
      details: {
        error: "invalid_solution_record",
        validationProblems: problems,
      },
    };
  }

  return {
    ok: true,
    candidate: {
      record,
      ...(requestedPath ? { candidatePath: normalizeRelativePath(requestedPath) } : {}),
    },
  };
}

export function createPrecedentAuditTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "precedent_audit",
    label: "Precedent Audit",
    description:
      "Inspect a candidate or existing solution precedent against higher-authority docs and sibling precedents to surface stale routing or contradiction maintenance work.",
    promptSnippet:
      "Use this when refreshing, displacing, or validating docs/solutions records so authority conflicts and stale routing stay explicit.",
    promptGuidelines: [
      "Prefer this before marking a record stale or superseded, or when a stable doc may have displaced an older precedent.",
      "Treat audit findings as repository-maintenance guidance, not runtime truth or hidden planner state.",
    ],
    parameters: Type.Object({
      solution_doc_path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      solution_record: Type.Optional(SolutionRecordInputSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(options.runtime, ctx);
      const loaded = loadAuditCandidate({
        scope,
        requestedPath: params.solution_doc_path,
        rawRecord: params.solution_record,
      });
      if (!loaded.ok) {
        return failTextResult(loaded.message, {
          ok: false,
          ...loaded.details,
        });
      }

      const audit = auditPrecedentRecord({
        scope,
        record: loaded.candidate.record,
        candidatePath: loaded.candidate.candidatePath,
        limit: params.limit,
      });

      const details = {
        ok: audit.verdict !== "fail",
        ...audit,
      };
      if (audit.verdict === "fail") {
        return failTextResult(formatAuditText(audit), details);
      }
      if (audit.verdict === "inconclusive") {
        return inconclusiveTextResult(formatAuditText(audit), details);
      }
      return textResult(formatAuditText(audit), details);
    },
  });
}
