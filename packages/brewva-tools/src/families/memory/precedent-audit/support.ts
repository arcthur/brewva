import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  executeKnowledgeSearch,
  type ExecutedKnowledgeSearch,
  type ScoredKnowledgeDoc,
} from "@brewva/brewva-recall/knowledge";
export { readTrimmedString } from "@brewva/brewva-std/unknown";
import {
  isPathInsideRoots,
  resolveScopedPath,
  resolveToolTargetScope,
} from "../../../runtime-port/target-scope.js";
import {
  type DerivativeLink,
  type NormalizedSolutionRecord,
  normalizeRelativePath,
  parseSolutionDocument,
} from "../solution-record.js";
import type {
  PrecedentAuditFinding,
  PrecedentAuditVerdict,
  PrecedentMaintenanceRecommendation,
} from "./types.js";

const DISPLACEMENT_TARGET_KINDS = new Set(["stable_doc", "solution_record"] as const);
const STABLE_DOC_PREFIXES = ["docs/architecture/", "docs/reference/"] as const;
export const SOLUTION_DOC_PREFIX = "docs/solutions/";
const PROMOTION_CANDIDATE_PREFIXES = [
  ".brewva/knowledge/materialized/",
  ".brewva/knowledge/",
] as const;

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

export function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return normalizeRelativePath(left) === normalizeRelativePath(right);
}

export function isActiveDoc(entry: ScoredKnowledgeDoc): boolean {
  return (entry.doc.status ?? "active").toLowerCase() === "active";
}

export function looksLikeSamePrecedent(
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

export function linksToSolutionPath(
  record: NormalizedSolutionRecord,
  solutionPath: string | undefined,
): boolean {
  if (!solutionPath) {
    return false;
  }
  const normalizedPath = normalizeRelativePath(solutionPath);
  return record.derivativeLinks.some((link) => normalizeDerivativeRef(link.ref) === normalizedPath);
}

export function loadPeerSolutionRecord(
  entry: ScoredKnowledgeDoc,
): NormalizedSolutionRecord | undefined {
  try {
    return parseSolutionDocument(readFileSync(entry.doc.absolutePath, "utf8")).record;
  } catch {
    return undefined;
  }
}

export function materiallyConflictsWithPeerPrecedent(input: {
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

export function dedupePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeRelativePath(value)))];
}

export function pushFinding(
  findings: PrecedentAuditFinding[],
  finding: PrecedentAuditFinding,
): PrecedentAuditFinding[] {
  if (findings.some((entry) => entry.code === finding.code && entry.summary === finding.summary)) {
    return findings;
  }
  findings.push(finding);
  return findings;
}

export function classifyDerivativeLink(
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

export function searchForAudit(
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

export function resolveMaintenanceRecommendation(input: {
  findings: readonly PrecedentAuditFinding[];
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

export function deriveVerdict(findings: readonly PrecedentAuditFinding[]): PrecedentAuditVerdict {
  if (findings.some((finding) => finding.severity === "error")) {
    return "fail";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "inconclusive";
  }
  return "pass";
}
