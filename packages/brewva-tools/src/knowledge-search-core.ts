import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-runtime/internal";
import Fuse from "fuse.js";
import type { FuseResultMatch } from "fuse.js";

export const KNOWLEDGE_SOURCE_TYPES = [
  "solution",
  "stable_doc",
  "research_note",
  "troubleshooting",
  "incident_record",
] as const;

export const KNOWLEDGE_QUERY_INTENTS = ["precedent_lookup", "normative_lookup"] as const;
export const FRESHNESS_SIGNALS = ["fresh", "aging", "stale", "unknown"] as const;

const KNOWLEDGE_SOURCE_ROOTS = [
  {
    relativeDir: "docs/solutions",
    sourceType: "solution",
    currentStateRank: 4,
    normativeRank: 2,
  },
  {
    relativeDir: "docs/architecture",
    sourceType: "stable_doc",
    currentStateRank: 2,
    normativeRank: 1,
  },
  {
    relativeDir: "docs/reference",
    sourceType: "stable_doc",
    currentStateRank: 2,
    normativeRank: 1,
  },
  {
    relativeDir: "docs/research",
    sourceType: "research_note",
    currentStateRank: 6,
    normativeRank: 5,
  },
  {
    relativeDir: "docs/troubleshooting",
    sourceType: "troubleshooting",
    currentStateRank: 5,
    normativeRank: 4,
  },
  {
    relativeDir: "docs/incidents",
    sourceType: "incident_record",
    currentStateRank: 3,
    normativeRank: 3,
  },
] as const satisfies readonly KnowledgeSourceRoot[];

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MIN_BOOTSTRAP_SOLUTION_RESULTS = 2;
const BOOTSTRAP_SOURCE_TYPES = KNOWLEDGE_SOURCE_TYPES.filter(
  (entry): entry is Exclude<KnowledgeSourceType, "solution"> => entry !== "solution",
);
const FUSE_THRESHOLD = 0.4;
const FUSE_BASE_SCORE = 1_000;
const FILTER_ONLY_BASE_SCORE = 100;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];
export type KnowledgeQueryIntent = (typeof KNOWLEDGE_QUERY_INTENTS)[number];
export type FreshnessSignal = (typeof FRESHNESS_SIGNALS)[number];

interface KnowledgeSourceRoot {
  relativeDir: string;
  sourceType: KnowledgeSourceType;
  currentStateRank: number;
  normativeRank: number;
}

export interface KnowledgeDocRecord {
  absolutePath: string;
  relativePath: string;
  sourceType: KnowledgeSourceType;
  title: string;
  body: string;
  excerpt: string;
  status?: string;
  problemKind?: string;
  module?: string;
  boundaries: string[];
  tags: string[];
  freshness: FreshnessSignal;
  updatedAt?: string;
}

export interface ScoredKnowledgeDoc {
  doc: KnowledgeDocRecord;
  authorityRank: number;
  intentPriority: number;
  relevanceScore: number;
  matchReasons: string[];
}

export interface KnowledgeSearchInput {
  query?: string;
  queryIntent?: KnowledgeQueryIntent;
  sourceTypes?: readonly KnowledgeSourceType[];
  module?: string;
  boundary?: string;
  tags?: readonly string[];
  problemKind?: string;
  status?: string;
  limit?: number;
}

export interface ExecutedKnowledgeSearch {
  querySummary: string;
  results: ScoredKnowledgeDoc[];
  searchedRoots: string[];
  searchPlan: {
    queryIntent: KnowledgeQueryIntent;
    mode: "explicit_source_types" | "solution_only" | "solution_then_bootstrap";
    solutionResultCount: number;
    broadened: boolean;
    consultedSourceTypes: KnowledgeSourceType[];
  };
}

interface RankedKnowledgeDoc extends ScoredKnowledgeDoc {
  queryScore: number;
  filterBoost: number;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => typeof entry === "string");
}

function extractHeadingTitle(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return readTrimmedString(match?.[1]);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  const compacted = compactWhitespace(value);
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(1, maxChars - 3))}...`;
}

function readUpdatedAt(data: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(data.updated_at) ??
    readTrimmedString(data.last_updated) ??
    readTrimmedString(data.last_reviewed)
  );
}

function resolveFreshnessSignal(updatedAt: string | undefined, now = Date.now()): FreshnessSignal {
  if (!updatedAt) return "unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  const ageDays = Math.max(0, (now - timestamp) / (1000 * 60 * 60 * 24));
  if (ageDays <= 90) return "fresh";
  if (ageDays <= 365) return "aging";
  return "stale";
}

export function freshnessRank(signal: FreshnessSignal): number {
  switch (signal) {
    case "fresh":
      return 3;
    case "aging":
      return 2;
    case "stale":
      return 1;
    default:
      return 0;
  }
}

const PRECEDENT_LOOKUP_ORDER: readonly KnowledgeSourceType[] = [
  "solution",
  "incident_record",
  "troubleshooting",
  "stable_doc",
  "research_note",
];

const NORMATIVE_LOOKUP_ORDER: readonly KnowledgeSourceType[] = [
  "stable_doc",
  "solution",
  "incident_record",
  "troubleshooting",
  "research_note",
];

function precedenceOrderForIntent(
  queryIntent: KnowledgeQueryIntent,
): readonly KnowledgeSourceType[] {
  return queryIntent === "normative_lookup" ? NORMATIVE_LOOKUP_ORDER : PRECEDENT_LOOKUP_ORDER;
}

function authorityColumnForIntent(
  doc: Pick<KnowledgeDocRecord, "sourceType">,
  queryIntent: KnowledgeQueryIntent,
): number {
  const root = KNOWLEDGE_SOURCE_ROOTS.find((entry) => entry.sourceType === doc.sourceType);
  if (!root) {
    return Number.MAX_SAFE_INTEGER;
  }
  return queryIntent === "normative_lookup" ? root.normativeRank : root.currentStateRank;
}

function intentPriorityForSourceType(
  doc: Pick<KnowledgeDocRecord, "sourceType">,
  queryIntent: KnowledgeQueryIntent,
): number {
  const order = precedenceOrderForIntent(queryIntent);
  const index = order.indexOf(doc.sourceType);
  if (index === -1) {
    return Number.MAX_SAFE_INTEGER;
  }
  return index + 1;
}

export function authorityRankForIntent(
  doc: Pick<KnowledgeDocRecord, "sourceType">,
  queryIntent: KnowledgeQueryIntent,
): number {
  return authorityColumnForIntent(doc, queryIntent);
}

function collectMarkdownFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (
        entry.isFile() &&
        /\.(md|mdx)$/i.test(entry.name) &&
        !/^readme\.mdx?$/i.test(entry.name)
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files.toSorted();
}

interface LoadedKnowledgeCorpus {
  docs: KnowledgeDocRecord[];
  searchedRoots: string[];
}

function loadKnowledgeDocs(searchRoot: string, workspaceRoot: string): LoadedKnowledgeCorpus {
  const docs: KnowledgeDocRecord[] = [];
  const searchedRoots: string[] = [];
  for (const sourceRoot of KNOWLEDGE_SOURCE_ROOTS) {
    const absoluteDir = join(searchRoot, sourceRoot.relativeDir);
    if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
      continue;
    }
    searchedRoots.push(relative(workspaceRoot, absoluteDir).replace(/\\/g, "/"));

    for (const absolutePath of collectMarkdownFiles(absoluteDir)) {
      const raw = readFileSync(absolutePath, "utf8");
      const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
      let data: Record<string, unknown>;
      let body: string;
      try {
        ({ data, body } = parseMarkdownFrontmatter(raw));
      } catch (error) {
        throw new Error(
          `invalid_knowledge_document:${relativePath}:${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const title =
        readTrimmedString(data.title) ?? extractHeadingTitle(body) ?? basename(absolutePath);
      const module = readTrimmedString(data.module);
      const boundaries = readStringArray(data.boundaries);
      const tags = readStringArray(data.tags);
      const status = readTrimmedString(data.status);
      const problemKind = readTrimmedString(data.problem_kind);
      const updatedAt = readUpdatedAt(data);
      const freshness = resolveFreshnessSignal(updatedAt);
      docs.push({
        absolutePath,
        relativePath,
        sourceType: sourceRoot.sourceType,
        title,
        body,
        excerpt: truncate(body, 220),
        status,
        problemKind,
        module,
        boundaries,
        tags,
        freshness,
        updatedAt,
      });
    }
  }
  return {
    docs,
    searchedRoots,
  };
}

function matchesFilters(
  doc: KnowledgeDocRecord,
  input: {
    sourceTypes?: readonly KnowledgeSourceType[];
    module?: string;
    boundary?: string;
    tags?: readonly string[];
    problemKind?: string;
    status?: string;
  },
): boolean {
  const normalizedModule = input.module?.toLowerCase();
  const normalizedBoundary = input.boundary?.toLowerCase();
  const normalizedProblemKind = input.problemKind?.toLowerCase();
  const normalizedStatus = input.status?.toLowerCase();
  const normalizedTags = (input.tags ?? []).map((tag) => tag.toLowerCase());

  if (
    input.sourceTypes &&
    input.sourceTypes.length > 0 &&
    !input.sourceTypes.includes(doc.sourceType)
  ) {
    return false;
  }
  if (normalizedModule && doc.module?.toLowerCase() !== normalizedModule) {
    return false;
  }
  if (
    normalizedBoundary &&
    !doc.boundaries.some((boundary) => boundary.toLowerCase() === normalizedBoundary)
  ) {
    return false;
  }
  if (normalizedProblemKind && doc.problemKind?.toLowerCase() !== normalizedProblemKind) {
    return false;
  }
  if (normalizedStatus && doc.status?.toLowerCase() !== normalizedStatus) {
    return false;
  }
  if (
    normalizedTags.length > 0 &&
    !normalizedTags.every((tag) => doc.tags.some((entry) => entry.toLowerCase() === tag))
  ) {
    return false;
  }
  return true;
}

function normalizeScore(score: number | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return 0;
  }
  const bounded = Math.max(0, Math.min(1, score));
  return Math.max(1, Math.round((1 - bounded) * FUSE_BASE_SCORE));
}

function mapFuseKeyToReason(
  key: string | number | readonly string[] | undefined,
): string | undefined {
  if (Array.isArray(key)) {
    const joined = key.join(".");
    return mapFuseKeyToReason(joined);
  }
  switch (key) {
    case "title":
      return "title";
    case "relativePath":
      return "path";
    case "body":
      return "content";
    case "tags":
      return "tags";
    case "boundaries":
      return "boundaries";
    case "module":
      return "module";
    case "problemKind":
      return "problem_kind";
    case "status":
      return "status";
    default:
      return undefined;
  }
}

function collectFuseMatchReasons(matches: readonly FuseResultMatch[] | undefined): Set<string> {
  const reasons = new Set<string>();
  for (const match of matches ?? []) {
    const reason = mapFuseKeyToReason(match.key);
    if (reason) {
      reasons.add(reason);
    }
  }
  return reasons;
}

function collectFilterBoost(input: {
  doc: KnowledgeDocRecord;
  module?: string;
  boundary?: string;
  tags?: readonly string[];
}): { boost: number; reasons: string[] } {
  let boost = 0;
  const reasons: string[] = [];
  const normalizedModule = input.module?.toLowerCase();
  const normalizedBoundary = input.boundary?.toLowerCase();
  const normalizedTags = (input.tags ?? []).map((tag) => tag.toLowerCase());

  if (normalizedModule && input.doc.module?.toLowerCase() === normalizedModule) {
    boost += 120;
    reasons.push("module_filter");
  }
  if (
    normalizedBoundary &&
    input.doc.boundaries.some((boundary) => boundary.toLowerCase() === normalizedBoundary)
  ) {
    boost += 100;
    reasons.push("boundary_filter");
  }
  if (
    normalizedTags.length > 0 &&
    normalizedTags.every((tag) => input.doc.tags.some((entry) => entry.toLowerCase() === tag))
  ) {
    boost += normalizedTags.length * 80;
    reasons.push("tag_filter");
  }

  return { boost, reasons };
}

function buildRankedDoc(input: {
  doc: KnowledgeDocRecord;
  queryIntent: KnowledgeQueryIntent;
  queryScore: number;
  queryReasons?: Set<string>;
  module?: string;
  boundary?: string;
  tags?: readonly string[];
}): RankedKnowledgeDoc {
  const filterBoost = collectFilterBoost({
    doc: input.doc,
    module: input.module,
    boundary: input.boundary,
    tags: input.tags,
  });
  const reasonSet = new Set(input.queryReasons ?? []);
  for (const reason of filterBoost.reasons) {
    reasonSet.add(reason);
  }
  if (input.queryScore <= 0 && reasonSet.size === 0) {
    reasonSet.add("filter_only");
  }

  return {
    doc: input.doc,
    authorityRank: authorityColumnForIntent(input.doc, input.queryIntent),
    intentPriority: intentPriorityForSourceType(input.doc, input.queryIntent),
    queryScore: input.queryScore,
    filterBoost: filterBoost.boost,
    relevanceScore: input.queryScore + filterBoost.boost,
    matchReasons: [...reasonSet].toSorted(),
  };
}

function dedupeScoredDocs(entries: readonly RankedKnowledgeDoc[]): RankedKnowledgeDoc[] {
  return [...new Map(entries.map((entry) => [entry.doc.absolutePath, entry])).values()];
}

function compareScoredDocs(left: RankedKnowledgeDoc, right: RankedKnowledgeDoc): number {
  if (right.relevanceScore !== left.relevanceScore) {
    return right.relevanceScore - left.relevanceScore;
  }
  if (right.queryScore !== left.queryScore) {
    return right.queryScore - left.queryScore;
  }
  if (right.filterBoost !== left.filterBoost) {
    return right.filterBoost - left.filterBoost;
  }
  if (left.intentPriority !== right.intentPriority) {
    return left.intentPriority - right.intentPriority;
  }
  if (left.authorityRank !== right.authorityRank) {
    return left.authorityRank - right.authorityRank;
  }
  if (freshnessRank(right.doc.freshness) !== freshnessRank(left.doc.freshness)) {
    return freshnessRank(right.doc.freshness) - freshnessRank(left.doc.freshness);
  }
  return left.doc.relativePath.localeCompare(right.doc.relativePath);
}

function createKnowledgeFuse(docs: readonly KnowledgeDocRecord[]): Fuse<KnowledgeDocRecord> {
  return new Fuse(docs, {
    includeMatches: true,
    includeScore: true,
    ignoreLocation: true,
    threshold: FUSE_THRESHOLD,
    minMatchCharLength: 2,
    keys: [
      { name: "title", weight: 4.5 },
      { name: "module", weight: 3.6 },
      { name: "boundaries", weight: 3.4 },
      { name: "tags", weight: 3.2 },
      { name: "relativePath", weight: 2.6 },
      { name: "problemKind", weight: 1.8 },
      { name: "status", weight: 1.2 },
      { name: "body", weight: 1.6 },
    ],
  });
}

function searchDocs(
  docs: readonly KnowledgeDocRecord[],
  input: {
    query?: string;
    queryIntent: KnowledgeQueryIntent;
    sourceTypes?: readonly KnowledgeSourceType[];
    module?: string;
    boundary?: string;
    tags?: readonly string[];
    problemKind?: string;
    status?: string;
    limit: number;
  },
): RankedKnowledgeDoc[] {
  const filteredDocs = docs.filter((doc) =>
    matchesFilters(doc, {
      sourceTypes: input.sourceTypes,
      module: input.module,
      boundary: input.boundary,
      tags: input.tags,
      problemKind: input.problemKind,
      status: input.status,
    }),
  );
  if (filteredDocs.length === 0) {
    return [];
  }

  if (!input.query) {
    return filteredDocs
      .map((doc) =>
        buildRankedDoc({
          doc,
          queryIntent: input.queryIntent,
          queryScore: FILTER_ONLY_BASE_SCORE,
          module: input.module,
          boundary: input.boundary,
          tags: input.tags,
        }),
      )
      .toSorted(compareScoredDocs)
      .slice(0, input.limit);
  }

  const fuse = createKnowledgeFuse(filteredDocs);
  return fuse
    .search(input.query)
    .map((entry) =>
      buildRankedDoc({
        doc: entry.item,
        queryIntent: input.queryIntent,
        queryScore: normalizeScore(entry.score),
        queryReasons: collectFuseMatchReasons(entry.matches),
        module: input.module,
        boundary: input.boundary,
        tags: input.tags,
      }),
    )
    .toSorted(compareScoredDocs)
    .slice(0, input.limit);
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit ?? DEFAULT_SEARCH_LIMIT));
}

export function hasKnowledgeSearchSignal(input: KnowledgeSearchInput): boolean {
  return Boolean(
    readTrimmedString(input.query) ||
    readTrimmedString(input.module) ||
    readTrimmedString(input.boundary) ||
    readTrimmedString(input.problemKind) ||
    readTrimmedString(input.status) ||
    (input.tags ?? []).some((entry) => readTrimmedString(entry)),
  );
}

export function normalizeKnowledgeSourceTypes(
  sourceTypes: readonly unknown[] | undefined,
): KnowledgeSourceType[] {
  if (!sourceTypes) {
    return [];
  }
  return sourceTypes.filter(
    (entry): entry is KnowledgeSourceType =>
      typeof entry === "string" && KNOWLEDGE_SOURCE_TYPES.includes(entry as KnowledgeSourceType),
  );
}

export function buildKnowledgeQuerySummary(input: {
  query?: string;
  queryIntent: KnowledgeQueryIntent;
  module?: string;
  boundary?: string;
  tags?: readonly string[];
  problemKind?: string;
  status?: string;
  sourceTypes?: readonly KnowledgeSourceType[];
  searchPlan: ExecutedKnowledgeSearch["searchPlan"];
}): string {
  return [
    `query=${input.query ?? "none"}`,
    `query_intent=${input.queryIntent}`,
    `module=${input.module ?? "none"}`,
    `boundary=${input.boundary ?? "none"}`,
    `tags=${input.tags && input.tags.length > 0 ? input.tags.join(", ") : "none"}`,
    `problem_kind=${input.problemKind ?? "none"}`,
    `status=${input.status ?? "none"}`,
    `source_types=${
      input.sourceTypes && input.sourceTypes.length > 0 ? input.sourceTypes.join(", ") : "auto"
    }`,
    `search_mode=${input.searchPlan.mode}`,
    `solution_results=${input.searchPlan.solutionResultCount}`,
    `broadened=${input.searchPlan.broadened ? "yes" : "no"}`,
  ].join(" | ");
}

export function executeKnowledgeSearch(
  searchRoots: readonly string[],
  input: KnowledgeSearchInput,
): ExecutedKnowledgeSearch {
  const query = readTrimmedString(input.query);
  const queryIntent = input.queryIntent ?? "precedent_lookup";
  const module = readTrimmedString(input.module);
  const boundary = readTrimmedString(input.boundary);
  const problemKind = readTrimmedString(input.problemKind);
  const status = readTrimmedString(input.status);
  const tags = (input.tags ?? [])
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const sourceTypes = normalizeKnowledgeSourceTypes(input.sourceTypes);
  const limit = clampLimit(input.limit);

  const corpora = searchRoots.map((root) => loadKnowledgeDocs(root, root));
  const uniqueDocs = [
    ...new Map(
      corpora.flatMap((corpus) => corpus.docs).map((doc) => [doc.absolutePath, doc]),
    ).values(),
  ];
  const searchedRoots = [...new Set(corpora.flatMap((corpus) => corpus.searchedRoots))].toSorted();

  let results: RankedKnowledgeDoc[] = [];
  let searchPlan: ExecutedKnowledgeSearch["searchPlan"];
  if (sourceTypes.length > 0) {
    results = searchDocs(uniqueDocs, {
      query,
      queryIntent,
      sourceTypes,
      module,
      boundary,
      tags,
      problemKind,
      status,
      limit,
    });
    searchPlan = {
      queryIntent,
      mode: "explicit_source_types",
      solutionResultCount: results.filter((entry) => entry.doc.sourceType === "solution").length,
      broadened: false,
      consultedSourceTypes: [...new Set(results.map((entry) => entry.doc.sourceType))],
    };
  } else {
    const solutionResults = searchDocs(uniqueDocs, {
      query,
      queryIntent,
      sourceTypes: ["solution"],
      module,
      boundary,
      tags,
      problemKind,
      status,
      limit,
    });
    const scopedIncidentResults =
      module || boundary
        ? searchDocs(uniqueDocs, {
            query,
            queryIntent,
            sourceTypes: ["incident_record"],
            module,
            boundary,
            tags,
            problemKind,
            status,
            limit,
          })
        : [];
    const hasScopedRepositoryPrecedent =
      (!module && !boundary) ||
      solutionResults.some(
        (entry) =>
          (!module || entry.doc.module?.toLowerCase() === module.toLowerCase()) &&
          (!boundary ||
            entry.doc.boundaries.some(
              (candidateBoundary) => candidateBoundary.toLowerCase() === boundary.toLowerCase(),
            )),
      ) ||
      scopedIncidentResults.some(
        (entry) =>
          (!module || entry.doc.module?.toLowerCase() === module.toLowerCase()) &&
          (!boundary ||
            entry.doc.boundaries.some(
              (candidateBoundary) => candidateBoundary.toLowerCase() === boundary.toLowerCase(),
            )),
      );
    const enoughSolutions =
      solutionResults.length >= Math.min(limit, MIN_BOOTSTRAP_SOLUTION_RESULTS) &&
      hasScopedRepositoryPrecedent;
    if (enoughSolutions) {
      results = solutionResults;
      searchPlan = {
        queryIntent,
        mode: "solution_only",
        solutionResultCount: solutionResults.length,
        broadened: false,
        consultedSourceTypes: ["solution"],
      };
    } else {
      const bootstrapResults = searchDocs(uniqueDocs, {
        query,
        queryIntent,
        sourceTypes: BOOTSTRAP_SOURCE_TYPES,
        module,
        boundary,
        tags,
        problemKind,
        status,
        limit,
      });
      results = dedupeScoredDocs([...solutionResults, ...bootstrapResults])
        .toSorted(compareScoredDocs)
        .slice(0, limit);
      searchPlan = {
        queryIntent,
        mode: "solution_then_bootstrap",
        solutionResultCount: solutionResults.length,
        broadened: true,
        consultedSourceTypes: [...new Set(results.map((entry) => entry.doc.sourceType))],
      };
    }
  }

  return {
    querySummary: buildKnowledgeQuerySummary({
      query,
      queryIntent,
      module,
      boundary,
      tags,
      problemKind,
      status,
      ...(sourceTypes.length > 0 ? { sourceTypes } : {}),
      searchPlan,
    }),
    results,
    searchedRoots,
    searchPlan,
  };
}
