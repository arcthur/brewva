import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { parseFrontmatter, readFrontmatterString } from "./utils/frontmatter.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";

export const SOLUTION_STATUSES = ["active", "stale", "superseded"] as const;
export const DERIVATIVE_TARGET_KINDS = [
  "promotion_candidate",
  "stable_doc",
  "solution_record",
] as const;
export const DERIVATIVE_RELATIONS = [
  "related",
  "derived_from",
  "promoted_to",
  "supersedes",
  "superseded_by",
] as const;

export const SolutionStatusSchema = buildStringEnumSchema(SOLUTION_STATUSES, {});
export const DerivativeTargetKindSchema = buildStringEnumSchema(DERIVATIVE_TARGET_KINDS, {});
export const DerivativeRelationSchema = buildStringEnumSchema(DERIVATIVE_RELATIONS, {});

export type SolutionStatus = (typeof SOLUTION_STATUSES)[number];
export type DerivativeTargetKind = (typeof DERIVATIVE_TARGET_KINDS)[number];
export type DerivativeRelation = (typeof DERIVATIVE_RELATIONS)[number];

export interface SolutionSection {
  heading: string;
  body: string;
}

export interface DerivativeLink {
  relation: DerivativeRelation;
  targetKind: DerivativeTargetKind;
  ref: string;
  note?: string;
}

export interface NormalizedSolutionRecord {
  id?: string;
  title: string;
  status: SolutionStatus;
  problemKind: string;
  module?: string;
  boundaries: string[];
  sourceArtifacts: string[];
  tags: string[];
  updatedAt?: string;
  sections: SolutionSection[];
  derivativeLinks: DerivativeLink[];
}

export interface ParsedSolutionDocument {
  id?: string;
  updatedAt?: string;
  record: NormalizedSolutionRecord;
}

export const SolutionRecordInputSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  status: Type.Optional(SolutionStatusSchema),
  problem_kind: Type.String({ minLength: 1, maxLength: 80 }),
  module: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  boundaries: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 24 }),
  ),
  source_artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    minItems: 1,
    maxItems: 24,
  }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 24 })),
  updated_at: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
  sections: Type.Array(
    Type.Object({
      heading: Type.String({ minLength: 1, maxLength: 120 }),
      body: Type.String({ minLength: 1, maxLength: 24_000 }),
    }),
    { minItems: 1, maxItems: 16 },
  ),
  derivative_links: Type.Optional(
    Type.Array(
      Type.Object({
        relation: DerivativeRelationSchema,
        target_kind: DerivativeTargetKindSchema,
        ref: Type.String({ minLength: 1, maxLength: 512 }),
        note: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      }),
      { maxItems: 16 },
    ),
  ),
});

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const parsed = readTrimmedString(entry);
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function normalizeSectionHeading(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeBody(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "general";
}

function renderFrontmatterScalar(value: string): string {
  return /^[A-Za-z0-9._/-]+(?: [A-Za-z0-9._/-]+)*$/u.test(value) ? value : JSON.stringify(value);
}

export function formatIsoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeDocumentText(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

export function deriveSolutionSlug(record: NormalizedSolutionRecord): string {
  return sanitizePathSegment(record.title);
}

export function deriveSolutionFamily(record: NormalizedSolutionRecord): string {
  return sanitizePathSegment(record.module ?? record.problemKind);
}

export function deriveSolutionRelativePath(record: NormalizedSolutionRecord): string {
  return normalizeRelativePath(
    join("docs", "solutions", deriveSolutionFamily(record), `${deriveSolutionSlug(record)}.md`),
  );
}

export function deriveSolutionId(record: NormalizedSolutionRecord, updatedAt: string): string {
  const datePart = updatedAt
    .replaceAll(/[^0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `sol-${datePart || "undated"}-${deriveSolutionSlug(record)}`;
}

export function isInvestigationProblemKind(problemKind: string): boolean {
  const normalized = problemKind.trim().toLowerCase();
  return normalized === "bugfix" || normalized === "incident";
}

export function hasSection(sections: readonly SolutionSection[], heading: string): boolean {
  const target = normalizeSectionHeading(heading).toLowerCase();
  return sections.some(
    (section) => normalizeSectionHeading(section.heading).toLowerCase() === target,
  );
}

function normalizeSections(value: unknown): SolutionSection[] {
  if (!Array.isArray(value)) return [];
  const sections: SolutionSection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const heading = readTrimmedString((entry as { heading?: unknown }).heading);
    const body = readTrimmedString((entry as { body?: unknown }).body);
    if (!heading || !body) {
      continue;
    }
    sections.push({
      heading: normalizeSectionHeading(heading),
      body: normalizeBody(body),
    });
  }
  return sections;
}

function normalizeDerivativeLinks(value: unknown): DerivativeLink[] {
  if (!Array.isArray(value)) return [];
  const links: DerivativeLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const relation = readTrimmedString((entry as { relation?: unknown }).relation);
    const targetKind = readTrimmedString((entry as { target_kind?: unknown }).target_kind);
    const ref = readTrimmedString((entry as { ref?: unknown }).ref);
    const note = readTrimmedString((entry as { note?: unknown }).note);
    if (
      !relation ||
      !targetKind ||
      !ref ||
      !DERIVATIVE_RELATIONS.includes(relation as DerivativeRelation) ||
      !DERIVATIVE_TARGET_KINDS.includes(targetKind as DerivativeTargetKind)
    ) {
      continue;
    }
    links.push({
      relation: relation as DerivativeRelation,
      targetKind: targetKind as DerivativeTargetKind,
      ref,
      ...(note ? { note } : {}),
    });
  }
  return links;
}

export function normalizeSolutionRecord(raw: {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  problem_kind?: unknown;
  module?: unknown;
  boundaries?: unknown;
  source_artifacts?: unknown;
  tags?: unknown;
  updated_at?: unknown;
  sections?: unknown;
  derivative_links?: unknown;
}): NormalizedSolutionRecord {
  const status = readTrimmedString(raw.status);
  const id = readTrimmedString(raw.id);
  const moduleName = readTrimmedString(raw.module);
  const updatedAt = readTrimmedString(raw.updated_at);
  return {
    ...(id ? { id } : {}),
    title: readTrimmedString(raw.title) ?? "",
    status:
      status && SOLUTION_STATUSES.includes(status as SolutionStatus)
        ? (status as SolutionStatus)
        : "active",
    problemKind: readTrimmedString(raw.problem_kind) ?? "",
    ...(moduleName ? { module: moduleName } : {}),
    boundaries: uniqueStrings(readStringArray(raw.boundaries)),
    sourceArtifacts: uniqueStrings(readStringArray(raw.source_artifacts)),
    tags: uniqueStrings(readStringArray(raw.tags)),
    ...(updatedAt ? { updatedAt } : {}),
    sections: normalizeSections(raw.sections),
    derivativeLinks: normalizeDerivativeLinks(raw.derivative_links),
  };
}

export function validateSolutionRecord(record: NormalizedSolutionRecord): string[] {
  const problems: string[] = [];
  if (!record.title) {
    problems.push("solution_record.title is required.");
  }
  if (!record.problemKind) {
    problems.push("solution_record.problem_kind is required.");
  }
  if (record.sourceArtifacts.length === 0) {
    problems.push(
      "solution_record.source_artifacts must contain at least one authoritative artifact.",
    );
  }
  if (record.sections.length === 0) {
    problems.push("solution_record.sections must contain at least one section.");
  }

  const seenHeadings = new Set<string>();
  for (const section of record.sections) {
    const normalized = section.heading.toLowerCase();
    if (seenHeadings.has(normalized)) {
      problems.push(`duplicate section heading: ${section.heading}`);
      break;
    }
    seenHeadings.add(normalized);
  }

  if (isInvestigationProblemKind(record.problemKind)) {
    if (!record.sourceArtifacts.includes("investigation_record")) {
      problems.push(
        "bugfix and incident captures require investigation_record in solution_record.source_artifacts.",
      );
    }
    if (!hasSection(record.sections, "Failed Attempts")) {
      problems.push("bugfix and incident captures require a Failed Attempts section.");
    }
  }

  if (record.status !== "active" && record.derivativeLinks.length === 0) {
    problems.push("stale or superseded solution records require at least one derivative link.");
  }

  return problems;
}

function renderFrontmatter(
  record: NormalizedSolutionRecord,
  input: { id: string; updatedAt: string },
): string {
  const lines = [
    "---",
    `id: ${renderFrontmatterScalar(input.id)}`,
    `title: ${renderFrontmatterScalar(record.title)}`,
    `status: ${record.status}`,
    `problem_kind: ${renderFrontmatterScalar(record.problemKind)}`,
  ];

  if (record.module) {
    lines.push(`module: ${renderFrontmatterScalar(record.module)}`);
  }
  if (record.boundaries.length > 0) {
    lines.push("boundaries:");
    for (const boundary of record.boundaries) {
      lines.push(`  - ${renderFrontmatterScalar(boundary)}`);
    }
  }
  lines.push("source_artifacts:");
  for (const artifact of record.sourceArtifacts) {
    lines.push(`  - ${renderFrontmatterScalar(artifact)}`);
  }
  if (record.tags.length > 0) {
    lines.push("tags:");
    for (const tag of record.tags) {
      lines.push(`  - ${renderFrontmatterScalar(tag)}`);
    }
  }
  lines.push(`updated_at: ${renderFrontmatterScalar(input.updatedAt)}`, "---");
  return `${lines.join("\n")}\n`;
}

function renderSections(sections: readonly SolutionSection[]): string {
  return sections.map((section) => `## ${section.heading}\n\n${section.body}\n`).join("\n");
}

function renderDerivativeLinks(links: readonly DerivativeLink[]): string {
  if (links.length === 0) return "";
  const lines = ["## Derivative Links", ""];
  for (const link of links) {
    const detail = link.note ? ` (${link.note})` : "";
    lines.push(`- ${link.relation} -> ${link.targetKind}: ${link.ref}${detail}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderSolutionDocument(
  record: NormalizedSolutionRecord,
  input: { id: string; updatedAt: string },
): string {
  const frontmatter = renderFrontmatter(record, input);
  const sections = renderSections(record.sections);
  const derivativeLinks = renderDerivativeLinks(record.derivativeLinks);
  return [frontmatter, `# ${record.title}\n`, sections, derivativeLinks]
    .filter((part) => part.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function extractHeadingTitle(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return readTrimmedString(match?.[1]);
}

function parseDerivativeLinkLine(line: string): DerivativeLink | undefined {
  const normalized = line.trim();
  if (!normalized.startsWith("- ")) {
    return undefined;
  }
  const match = /^-\s+([a-z_]+)\s+->\s+([a-z_]+):\s+(.+?)(?:\s+\((.+)\))?$/.exec(normalized);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  const relation = match[1] as DerivativeRelation;
  const targetKind = match[2] as DerivativeTargetKind;
  if (!DERIVATIVE_RELATIONS.includes(relation) || !DERIVATIVE_TARGET_KINDS.includes(targetKind)) {
    return undefined;
  }
  const ref = match[3].trim();
  const note = readTrimmedString(match[4]);
  return {
    relation,
    targetKind,
    ref,
    ...(note ? { note } : {}),
  };
}

function parseBodySections(body: string): {
  sections: SolutionSection[];
  derivativeLinks: DerivativeLink[];
} {
  const normalized = normalizeDocumentText(body);
  const lines = normalized.split("\n");
  const sections: SolutionSection[] = [];
  const derivativeLinks: DerivativeLink[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  function flushCurrent(): void {
    if (!currentHeading) {
      return;
    }
    const heading = normalizeSectionHeading(currentHeading);
    const bodyText = normalizeBody(currentLines.join("\n"));
    currentHeading = null;
    currentLines = [];
    if (!bodyText) {
      return;
    }
    if (heading.toLowerCase() === "derivative links") {
      for (const line of bodyText.split("\n")) {
        const link = parseDerivativeLinkLine(line);
        if (link) {
          derivativeLinks.push(link);
        }
      }
      return;
    }
    sections.push({ heading, body: bodyText });
  }

  for (const line of lines) {
    const headingMatch = /^##\s+(.+)$/.exec(line.trim());
    if (headingMatch?.[1]) {
      flushCurrent();
      currentHeading = headingMatch[1];
      continue;
    }
    if (currentHeading) {
      currentLines.push(line);
    }
  }
  flushCurrent();

  return {
    sections,
    derivativeLinks,
  };
}

export function parseSolutionDocument(input: string): ParsedSolutionDocument {
  const { data, body } = parseFrontmatter(input);
  const parsedBody = parseBodySections(body);
  const title = readTrimmedString(data.title) ?? extractHeadingTitle(body) ?? "";
  const record = normalizeSolutionRecord({
    id: data.id,
    title,
    status: data.status,
    problem_kind: data.problem_kind,
    module: data.module,
    boundaries: data.boundaries,
    source_artifacts: data.source_artifacts,
    tags: data.tags,
    updated_at: readFrontmatterString(data, "updated_at"),
    sections: parsedBody.sections,
    derivative_links: parsedBody.derivativeLinks.map((link) => {
      const normalizedLink: {
        relation: DerivativeRelation;
        target_kind: DerivativeTargetKind;
        ref: string;
        note?: string;
      } = {
        relation: link.relation,
        target_kind: link.targetKind,
        ref: link.ref,
      };
      if (link.note) {
        normalizedLink.note = link.note;
      }
      return normalizedLink;
    }),
  });

  return {
    ...(record.id ? { id: record.id } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    record,
  };
}
