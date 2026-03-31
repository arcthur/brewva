import type { SkillDocument } from "@brewva/brewva-runtime";
import { summarizeImpactMapSearchSignal } from "./impact-map.js";
import {
  executeKnowledgeSearch,
  hasKnowledgeSearchSignal,
  KNOWLEDGE_SOURCE_TYPES,
  type KnowledgeSearchInput,
  type KnowledgeSourceType,
  type ScoredKnowledgeDoc,
} from "./knowledge-search-core.js";

export const LEARNING_RESEARCH_OUTPUT_KEYS = [
  "knowledge_brief",
  "precedent_refs",
  "preventive_checks",
  "precedent_query_summary",
  "precedent_consult_status",
] as const;

type LearningResearchOutputKey = (typeof LEARNING_RESEARCH_OUTPUT_KEYS)[number];

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function compactSentence(value: string, maxChars = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function sentenceFromParagraph(body: string): string | undefined {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return undefined;
  }
  const flattened = normalized.replace(/\n+/g, " ").trim();
  const match = flattened.match(/.+?[.!?](?:\s|$)/);
  return compactSentence(match?.[0] ?? flattened);
}

function parseMarkdownSections(body: string): Array<{ heading: string; body: string }> {
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  function pushCurrent(): void {
    if (!currentHeading) {
      return;
    }
    const bodyText = currentBody.join("\n").trim();
    if (bodyText.length === 0) {
      return;
    }
    sections.push({
      heading: currentHeading,
      body: bodyText,
    });
  }

  for (const line of lines) {
    const headingMatch = /^##\s+(.+)$/.exec(line.trim());
    if (headingMatch?.[1]) {
      pushCurrent();
      currentHeading = headingMatch[1].trim();
      currentBody = [];
      continue;
    }
    if (currentHeading) {
      currentBody.push(line);
    }
  }
  pushCurrent();
  return sections;
}

function readSectionSentence(
  sections: readonly { heading: string; body: string }[],
  candidates: readonly string[],
): string | undefined {
  const lowered = new Set(candidates.map((entry) => entry.toLowerCase()));
  for (const section of sections) {
    if (lowered.has(section.heading.toLowerCase())) {
      return sentenceFromParagraph(section.body);
    }
  }
  return undefined;
}

function readBulletLines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => compactSentence(line.replace(/^[-*]\s+/, "")));
}

function extractPreventiveChecksFromDoc(entry: ScoredKnowledgeDoc): string[] {
  const sections = parseMarkdownSections(entry.doc.body);
  const checks: string[] = [];
  for (const section of sections) {
    const heading = section.heading.toLowerCase();
    if (
      heading === "prevention" ||
      heading === "preventive checks" ||
      heading === "guardrails" ||
      heading === "verification" ||
      heading === "why this works"
    ) {
      checks.push(...readBulletLines(section.body));
      const sentence = sentenceFromParagraph(section.body);
      if (sentence) {
        checks.push(sentence);
      }
    }
  }
  if (checks.length > 0) {
    return [...new Set(checks)].slice(0, 3);
  }

  const fallbackSentence =
    readSectionSentence(sections, ["Solution", "Guidance", "Problem"]) ??
    sentenceFromParagraph(entry.doc.body);
  if (!fallbackSentence) {
    return [];
  }
  return [
    compactSentence(
      `${fallbackSentence} (consult ${entry.doc.relativePath} before changing adjacent code.)`,
      220,
    ),
  ];
}

function formatSourceTypeLabel(sourceType: KnowledgeSourceType): string {
  return sourceType.replace(/_/g, " ");
}

function summarizeEntry(entry: ScoredKnowledgeDoc): string {
  const sections = parseMarkdownSections(entry.doc.body);
  const keySentence =
    readSectionSentence(sections, ["Problem", "Solution", "Guidance", "Why This Works"]) ??
    sentenceFromParagraph(entry.doc.body) ??
    entry.doc.excerpt;
  return compactSentence(
    `${entry.doc.title} (${formatSourceTypeLabel(entry.doc.sourceType)}, ${entry.doc.relativePath}): ${keySentence}`,
    220,
  );
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function deriveFallbackQuery(consumedOutputs: Record<string, unknown>): string | undefined {
  const parts = [
    readString(consumedOutputs.problem_frame),
    readString(consumedOutputs.scope_decision),
    readString(consumedOutputs.root_cause),
    summarizeImpactMapSearchSignal(consumedOutputs.impact_map),
    ...readStringArray(consumedOutputs.strategic_risks),
    ...readStringArray(consumedOutputs.user_pains),
  ].filter((entry): entry is string => Boolean(entry));
  if (parts.length === 0) {
    return undefined;
  }
  return compactSentence(parts.slice(0, 3).join(" "), 260);
}

function deriveFallbackModule(consumedOutputs: Record<string, unknown>): string | undefined {
  return readString(consumedOutputs.module_hint);
}

function deriveFallbackBoundary(consumedOutputs: Record<string, unknown>): string | undefined {
  return readString(consumedOutputs.boundary_hint);
}

function buildNoMatchChecks(input: {
  module?: string;
  boundary?: string;
  problemKind?: string;
  searchPlanMode: string;
}): string[] {
  const checks = [
    input.boundary
      ? `Re-verify the current ${input.boundary} boundary contract before finalizing the plan.`
      : undefined,
    input.module
      ? `Inspect the live ${input.module} implementation path instead of assuming an old precedent still applies.`
      : undefined,
    input.problemKind
      ? `Record why no repository precedent matched this ${input.problemKind} query before implementation proceeds.`
      : "Record why no repository precedent matched before implementation proceeds.",
    `Review whether ${input.searchPlanMode} search posture was too narrow for this task.`,
  ].filter((entry): entry is string => Boolean(entry));
  return dedupeStrings(checks).slice(0, 4);
}

export function isLearningResearchContractSkill(skill: SkillDocument | undefined): boolean {
  if (!skill) {
    return false;
  }
  const outputs = skill.contract.intent?.outputs ?? [];
  return LEARNING_RESEARCH_OUTPUT_KEYS.every((key) => outputs.includes(key));
}

export function buildLearningResearchOutputs(input: {
  activeSkill: SkillDocument | undefined;
  rawOutputs: Record<string, unknown>;
  consumedOutputs: Record<string, unknown>;
  searchRoots: readonly string[];
  params: {
    query?: unknown;
    sourceTypes?: unknown;
    module?: unknown;
    boundary?: unknown;
    tags?: unknown;
    problemKind?: unknown;
    status?: unknown;
    limit?: unknown;
  };
}):
  | {
      ok: true;
      outputs: Record<LearningResearchOutputKey, unknown>;
      details: {
        searchMode: string;
        broadened: boolean;
        consultedSourceTypes: KnowledgeSourceType[];
        matchedPaths: string[];
      };
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    } {
  if (!isLearningResearchContractSkill(input.activeSkill)) {
    return {
      ok: false,
      message:
        "Learning research synthesis rejected. The active skill does not declare the canonical learning-research outputs.",
      details: {
        activeSkill: input.activeSkill?.name ?? null,
      },
    };
  }

  const conflictingOutputs = LEARNING_RESEARCH_OUTPUT_KEYS.filter((key) =>
    hasOwn(input.rawOutputs, key),
  );
  if (conflictingOutputs.length > 0) {
    return {
      ok: false,
      message:
        "Learning research synthesis rejected. Do not supply manual learning-research outputs when learningResearch is enabled.",
      details: {
        conflictingOutputs,
      },
    };
  }

  const query = readString(input.params.query) ?? deriveFallbackQuery(input.consumedOutputs);
  const module = readString(input.params.module) ?? deriveFallbackModule(input.consumedOutputs);
  const boundary =
    readString(input.params.boundary) ?? deriveFallbackBoundary(input.consumedOutputs);
  const problemKind = readString(input.params.problemKind);
  const status = readString(input.params.status);
  const tags = readStringArray(input.params.tags);
  const sourceTypes = Array.isArray(input.params.sourceTypes)
    ? input.params.sourceTypes.filter(
        (entry): entry is KnowledgeSourceType =>
          typeof entry === "string" &&
          KNOWLEDGE_SOURCE_TYPES.includes(entry as KnowledgeSourceType),
      )
    : undefined;
  const limit =
    typeof input.params.limit === "number" && Number.isFinite(input.params.limit)
      ? input.params.limit
      : undefined;

  const searchInput: KnowledgeSearchInput = {
    ...(query ? { query } : {}),
    ...(sourceTypes && sourceTypes.length > 0 ? { sourceTypes } : {}),
    ...(module ? { module } : {}),
    ...(boundary ? { boundary } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(problemKind ? { problemKind } : {}),
    ...(status ? { status } : {}),
    ...(limit ? { limit } : {}),
  };

  if (!hasKnowledgeSearchSignal(searchInput)) {
    return {
      ok: false,
      message:
        "Learning research synthesis rejected. Provide query or filters, or ensure upstream consumed outputs contain enough search signal.",
    };
  }

  const search = executeKnowledgeSearch(input.searchRoots, searchInput);
  const matchedPaths = search.results.map((entry) => entry.doc.relativePath);
  const matched = matchedPaths.length > 0;

  const preventiveChecks = matched
    ? dedupeStrings(search.results.flatMap((entry) => extractPreventiveChecksFromDoc(entry))).slice(
        0,
        5,
      )
    : buildNoMatchChecks({
        module,
        boundary,
        problemKind,
        searchPlanMode: search.searchPlan.mode,
      });

  const knowledgeBrief = matched
    ? compactSentence(
        [
          `Consulted ${matchedPaths.length} repository knowledge record${matchedPaths.length === 1 ? "" : "s"} using ${search.searchPlan.mode} retrieval.`,
          ...search.results.slice(0, 3).map((entry) => summarizeEntry(entry)),
          search.searchPlan.consultedSourceTypes.includes("stable_doc")
            ? "Stable docs remain normative if they disagree with older solution records."
            : undefined,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(" "),
        900,
      )
    : compactSentence(
        [
          `No relevant repository precedent matched the explicit ${search.searchPlan.mode} consult path.`,
          module ? `Module focus: ${module}.` : undefined,
          boundary ? `Boundary focus: ${boundary}.` : undefined,
          "Proceed with fresh planning, but keep the preventive checks and query summary attached for later review.",
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(" "),
        500,
      );

  return {
    ok: true,
    outputs: {
      knowledge_brief: knowledgeBrief,
      precedent_refs: matchedPaths,
      preventive_checks: preventiveChecks,
      precedent_query_summary: search.querySummary,
      precedent_consult_status: matched ? "matched" : "no_relevant_precedent_found",
    },
    details: {
      searchMode: search.searchPlan.mode,
      broadened: search.searchPlan.broadened,
      consultedSourceTypes: search.searchPlan.consultedSourceTypes,
      matchedPaths,
    },
  };
}
