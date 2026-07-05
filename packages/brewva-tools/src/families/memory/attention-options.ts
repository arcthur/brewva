import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeKnowledgeSearch } from "@brewva/brewva-recall/knowledge";
import { scoreDocumentsByTfIdf } from "@brewva/brewva-search";
import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  compactWhitespace,
  normalizeStringList,
  readNonEmptyString,
  truncateText,
} from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
  listSkillResourceRefs,
  type AttentionOptionActionKind,
  type AttentionOptionProjection,
  type AttentionOptionSourceFamily,
  type SkillDocument,
} from "@brewva/brewva-vocabulary/session";
import {
  ATTENTION_PIN_RETENTION_HINT,
  type WorkbenchEntry,
} from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions, BrewvaToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  recordAttentionConsumption,
  recordMetricObservation,
} from "../../runtime-port/iteration.js";
import {
  resolveWorkspaceRoot,
  sessionAppliedTouchedFilePaths,
} from "../../runtime-port/session-touched-files.js";
import { resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import { noteWorkbench } from "../../runtime-port/workbench.js";
import { matchFileAgainstWriteVerifyTraps } from "../../shared/trap-library/index.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const MAX_OPTION_CARDS = 20;
const MAX_CARD_TEXT_CHARS = 180;
const MAX_CONSUMED_CHARS = 12_000;
const MAX_TAPE_EVENT_SAFE_KEYS = 16;
const MAX_TAPE_EVENT_SAFE_FIELDS = 12;
const MAX_TAPE_EVENT_SAFE_FIELD_CHARS = 240;
// Same per-source-family bound as recentTapeDocuments' `.slice(-8)` and
// repositoryPrecedentDocuments' knowledge-search `limit: 8` — one shared
// per-turn cap value reused across every bounded card source in this file,
// rather than a fresh magic number for trap-lens cards.
const MAX_TRAP_LENS_CARDS = 8;

const SENSITIVE_PAYLOAD_KEY_TOKENS = new Set([
  "args",
  "arg",
  "authorization",
  "body",
  "cmd",
  "command",
  "content",
  "cookie",
  "credential",
  "details",
  "env",
  "input",
  "output",
  "passwd",
  "password",
  "payload",
  "raw",
  "response",
  "result",
  "secret",
  "stderr",
  "stdin",
  "stdout",
  "text",
  "token",
]);

const TAPE_EVENT_SAFE_PAYLOAD_FIELDS = new Set([
  "adapter",
  "adoptionRequirement",
  "aggregation",
  "evidenceRefs",
  "freshness",
  "generationId",
  "hookName",
  "kind",
  "lifecycle",
  "metricKey",
  "name",
  "optionId",
  "patchSetId",
  "patchSetRefs",
  "phase",
  "posture",
  "ref",
  "refs",
  "role",
  "rootRef",
  "runId",
  "schema",
  "sessionScope",
  "source",
  "sourceFamily",
  "stableId",
  "status",
  "targetRoots",
  "toolName",
  "unit",
  "value",
]);

const ATTENTION_SOURCE_TYPES = Type.Union([
  Type.Literal("skill_card"),
  Type.Literal("workbench"),
  Type.Literal("surfaced_recall"),
  Type.Literal("session_tape_evidence"),
  Type.Literal("repository_precedent"),
  Type.Literal("trap_lens"),
]);

const ATTENTION_SOURCE_FAMILY_VALUES = [
  "skill_card",
  "workbench",
  "surfaced_recall",
  "session_tape_evidence",
  "repository_precedent",
  "trap_lens",
] as const satisfies readonly AttentionOptionSourceFamily[];

const ATTENTION_SOURCE_FAMILY_SET = new Set<string>(ATTENTION_SOURCE_FAMILY_VALUES);

interface AttentionOptionDocument {
  readonly id: string;
  readonly text: string;
  readonly card: AttentionOptionProjection;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return [...new Set(normalizeStringList(value))];
}

function isAttentionSourceFamily(value: string): value is AttentionOptionSourceFamily {
  return ATTENTION_SOURCE_FAMILY_SET.has(value);
}

function boundedText(value: string, maxChars = MAX_CARD_TEXT_CHARS): string {
  return truncateText(compactWhitespace(value), maxChars, { marker: "..." });
}

function estimateTokens(value: string): number | null {
  try {
    return estimateModelTokens(value).tokens;
  } catch {
    return null;
  }
}

function generationId(input: {
  readonly sessionId: string;
  readonly query: string | null;
  readonly sourceFamilies: readonly string[];
  readonly basisRefs: readonly string[];
}): string {
  return `attention_generation_${sha256Hex(
    [input.sessionId, input.query ?? "", ...input.sourceFamilies, ...input.basisRefs].join("\0"),
  ).slice(0, 16)}`;
}

function payloadKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function hasAdjacentPayloadKeyTokens(
  tokens: readonly string[],
  first: string,
  second: string,
): boolean {
  return tokens.some((token, index) => token === first && tokens[index + 1] === second);
}

function isSensitivePayloadKey(key: string): boolean {
  const tokens = payloadKeyTokens(key);
  return (
    tokens.some((token) => SENSITIVE_PAYLOAD_KEY_TOKENS.has(token)) ||
    hasAdjacentPayloadKeyTokens(tokens, "api", "key") ||
    hasAdjacentPayloadKeyTokens(tokens, "private", "key")
  );
}

function safeTapePayloadKey(key: string): string {
  return isSensitivePayloadKey(key) ? "[sensitive]" : key;
}

function describeSafeTapePayloadValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return boundedText(value, MAX_TAPE_EVENT_SAFE_FIELD_CHARS);
  }
  if (Array.isArray(value)) {
    if (depth > 0) {
      return `[array:${value.length}]`;
    }
    return value.slice(0, 8).map((entry) => describeSafeTapePayloadValue(entry, depth + 1));
  }
  const record = readRecord(value);
  if (!record || depth > 1) {
    return "[object]";
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => TAPE_EVENT_SAFE_PAYLOAD_FIELDS.has(key) && !isSensitivePayloadKey(key))
      .slice(0, MAX_TAPE_EVENT_SAFE_FIELDS)
      .map(([key, entry]) => [key, describeSafeTapePayloadValue(entry, depth + 1)]),
  );
}

function safeTapePayloadFields(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => TAPE_EVENT_SAFE_PAYLOAD_FIELDS.has(key) && !isSensitivePayloadKey(key))
      .slice(0, MAX_TAPE_EVENT_SAFE_FIELDS)
      .map(([key, value]) => [key, describeSafeTapePayloadValue(value)]),
  );
}

function renderTapeEventSummary(event: BrewvaEventRecord): string {
  const payload = readRecord(event.payload);
  const payloadKeys = payload
    ? [...new Set(Object.keys(payload).map(safeTapePayloadKey).slice(0, MAX_TAPE_EVENT_SAFE_KEYS))]
    : [];
  const safePayload = safeTapePayloadFields(payload);
  const lines = [
    "tape_event_summary:",
    `  event_id: ${event.id}`,
    `  event_type: ${event.type}`,
    `  session_id: ${event.sessionId}`,
    `  turn_id: ${event.turnId ?? "none"}`,
    `  turn: ${event.turn ?? "unknown"}`,
    `  timestamp: ${event.isoTime ?? event.timestamp}`,
    `  category: ${event.category ?? "none"}`,
    `  source: ${event.source ?? "none"}`,
    `  payload_keys: ${payloadKeys.join(",") || "none"}`,
  ];
  if (Object.keys(safePayload).length > 0) {
    lines.push(`  safe_payload: ${JSON.stringify(safePayload)}`);
  }
  return lines.join("\n");
}

function skillToDocument(skill: SkillDocument, generation: string): AttentionOptionDocument {
  const resourceRefs = listSkillResourceRefs(skill).map((ref) => `${ref.kind}:${ref.path}`);
  const text = [
    skill.name,
    skill.category,
    skill.description,
    skill.card.selection?.whenToUse,
    skill.card.argumentHints?.join(" "),
    skill.card.outputArtifacts?.join(" "),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  const card: AttentionOptionProjection = {
    schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
    optionId: `skill:${skill.name}`,
    generationId: generation,
    sourceFamily: "skill_card",
    rootRef: skill.filePath,
    title: skill.name,
    whyRelevant: boundedText(skill.card.selection?.whenToUse ?? skill.description),
    tokenEstimate: estimateTokens(text),
    resourceRefs,
    outputArtifacts: skill.card.outputArtifacts ?? [],
    allowedActions: ["consume", "pin", "ignore", "verify_plan"],
    authorityPosture: "none",
  };
  return { id: card.optionId, text, card };
}

function workbenchToDocument(
  entry: WorkbenchEntry,
  generation: string,
): AttentionOptionDocument | null {
  const content = readNonEmptyString(entry.content) ?? readNonEmptyString(entry.text);
  const stableRef = readNonEmptyString(entry.id) ?? entry.digest;
  if (!stableRef || !content) {
    return null;
  }
  const rootRef = `workbench:${stableRef}`;
  const card: AttentionOptionProjection = {
    schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
    optionId: rootRef,
    generationId: generation,
    sourceFamily: "workbench",
    rootRef,
    title: boundedText(content, 72),
    whyRelevant: boundedText(entry.reason),
    tokenEstimate: estimateTokens(content),
    resourceRefs: entry.sourceRefs,
    outputArtifacts: [],
    allowedActions: ["consume", "pin", "ignore", "verify_plan"],
    authorityPosture: "read_context",
  };
  return { id: card.optionId, text: [content, entry.reason, ...entry.sourceRefs].join("\n"), card };
}

function readRecallResults(
  event: BrewvaEventRecord,
  sourceFamilies: readonly AttentionOptionSourceFamily[],
): AttentionOptionDocument[] {
  const payload = readRecord(event.payload);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.flatMap((entry): AttentionOptionDocument[] => {
    const result = readRecord(entry);
    const stableId = readNonEmptyString(result?.stableId);
    const rootRef = readNonEmptyString(result?.rootRef);
    const sourceFamily = readNonEmptyString(result?.sourceFamily);
    if (!stableId || !rootRef) {
      return [];
    }
    const optionSourceFamily =
      sourceFamily === "repository_precedent" ? "repository_precedent" : "surfaced_recall";
    if (!sourceFamilies.includes(optionSourceFamily)) {
      return [];
    }
    const card: AttentionOptionProjection = {
      schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
      optionId: stableId,
      generationId: "",
      sourceFamily: optionSourceFamily,
      rootRef,
      title: stableId,
      whyRelevant: "Previously surfaced recall candidate.",
      tokenEstimate: null,
      resourceRefs: [rootRef],
      outputArtifacts: [],
      allowedActions: ["consume", "pin", "ignore", "verify_plan"],
      authorityPosture: "none",
    };
    return [{ id: stableId, text: [stableId, rootRef, sourceFamily].join("\n"), card }];
  });
}

function recentTapeDocuments(
  events: readonly BrewvaEventRecord[],
  generation: string,
): AttentionOptionDocument[] {
  return events
    .filter((event) => event.id && event.type)
    .slice(-8)
    .map((event) => {
      const rootRef = `event:${event.id}`;
      const summary = renderTapeEventSummary(event);
      const card: AttentionOptionProjection = {
        schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
        optionId: rootRef,
        generationId: generation,
        sourceFamily: "session_tape_evidence",
        rootRef,
        title: event.type,
        whyRelevant: `Recent session tape event ${event.type}.`,
        tokenEstimate: estimateTokens(summary),
        resourceRefs: [rootRef],
        outputArtifacts: [],
        allowedActions: ["consume", "pin", "ignore", "verify_plan"],
        authorityPosture: "none",
      };
      return { id: card.optionId, text: summary, card };
    });
}

/** Best-effort file read for trap-lens matching — an unreadable file contributes no card rather than failing the whole source. */
function readTouchedFileTextOrNull(workspaceRoot: string, path: string): string | null {
  try {
    return readFileSync(resolve(workspaceRoot, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * Trap-lens card source (Task 9): for every file touched by the session's
 * applied patch sets, run the shared write/verify trap match over its CURRENT
 * content and surface one bounded advisory card per distinct lens that fires.
 * `title` is the firing entry's id, `whyRelevant` is the lens text itself —
 * the card names both so a reader can trace a lens back to its trap entry.
 *
 * Deterministic and bounded: file order comes from
 * `sessionAppliedTouchedFilePaths` (first-seen tape order), lens order within
 * a file comes from `matchFileAgainstWriteVerifyTraps` (write-then-verify,
 * entry order) — the loop below stops the instant `MAX_TRAP_LENS_CARDS` cards
 * exist, so which files/lenses are seen next never affects which cards ship.
 * No I/O in the trap engine itself (axiom: pure engine, caller reads
 * content) — this function is the caller that reads the workspace file text
 * via the same best-effort pattern `review_request`'s lens preload uses.
 *
 * Advisory only (axiom 18): a firing card is an invitation to look, never a
 * defect claim and never a gate — see the trap-library module doc on
 * lens != verdict. `authorityPosture: "none"` because consuming this card
 * grants no write capability, matching `session_tape_evidence` and
 * `repository_precedent`.
 */
function trapLensDocuments(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly generation: string;
}): AttentionOptionDocument[] {
  const touchedPaths = sessionAppliedTouchedFilePaths(input.runtime, input.sessionId);
  const documents: AttentionOptionDocument[] = [];
  for (const path of touchedPaths) {
    if (documents.length >= MAX_TRAP_LENS_CARDS) {
      break;
    }
    const text = readTouchedFileTextOrNull(input.workspaceRoot, path);
    if (text === null) {
      continue;
    }
    for (const match of matchFileAgainstWriteVerifyTraps(text)) {
      if (documents.length >= MAX_TRAP_LENS_CARDS) {
        break;
      }
      const rootRef = path;
      const optionId = `trap_lens:${path}:${match.entry.id}`;
      const card: AttentionOptionProjection = {
        schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
        optionId,
        generationId: input.generation,
        sourceFamily: "trap_lens",
        rootRef,
        title: match.entry.id,
        whyRelevant: boundedText(match.lens),
        tokenEstimate: estimateTokens(match.lens),
        resourceRefs: [rootRef],
        outputArtifacts: [],
        allowedActions: ["consume", "pin", "ignore", "verify_plan"],
        authorityPosture: "none",
      };
      documents.push({ id: optionId, text: [match.entry.id, path, match.lens].join("\n"), card });
    }
  }
  return documents;
}

function repositoryPrecedentDocuments(input: {
  readonly searchRoots: readonly string[];
  readonly query: string | null;
  readonly generation: string;
}): AttentionOptionDocument[] {
  const search = executeKnowledgeSearch(input.searchRoots, {
    ...(input.query ? { query: input.query } : {}),
    sourceTypes: ["solution"],
    limit: 8,
  });
  return search.results.map((entry) => {
    const rootRef = entry.doc.relativePath;
    const optionId = `precedent:${rootRef}`;
    const text = [
      entry.doc.title,
      entry.doc.relativePath,
      entry.doc.excerpt,
      entry.matchReasons.join(" "),
      entry.doc.tags.join(" "),
      entry.doc.boundaries.join(" "),
    ].join("\n");
    const card: AttentionOptionProjection = {
      schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
      optionId,
      generationId: input.generation,
      sourceFamily: "repository_precedent",
      rootRef,
      title: entry.doc.title,
      whyRelevant: boundedText(entry.doc.excerpt || entry.matchReasons.join("; ")),
      tokenEstimate: estimateTokens(text),
      resourceRefs: [rootRef],
      outputArtifacts: [],
      allowedActions: ["consume", "pin", "ignore", "verify_plan"],
      authorityPosture: "none",
    };
    return { id: optionId, text, card };
  });
}

function collectOptionDocuments(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly query: string | null;
  readonly sourceFamilies: readonly AttentionOptionSourceFamily[];
  readonly searchRoots: readonly string[];
  readonly workspaceRoot: string;
}): { readonly generation: string; readonly documents: readonly AttentionOptionDocument[] } {
  const sourceFamilies = input.sourceFamilies.length
    ? input.sourceFamilies
    : ATTENTION_SOURCE_FAMILY_VALUES;
  const skills = sourceFamilies.includes("skill_card")
    ? input.runtime.capabilities.skills.catalog
        .list()
        .filter((skill) => skill.category !== "internal")
    : [];
  const workbenchEntries = sourceFamilies.includes("workbench")
    ? input.runtime.capabilities.workbench.list(input.sessionId)
    : [];
  const recallDocuments =
    sourceFamilies.includes("surfaced_recall") || sourceFamilies.includes("repository_precedent")
      ? input.runtime.capabilities.events.records
          .query(input.sessionId, { type: RECALL_RESULTS_SURFACED_EVENT_TYPE })
          .flatMap((event) => readRecallResults(event, sourceFamilies))
      : [];
  const tapeEvents = sourceFamilies.includes("session_tape_evidence")
    ? input.runtime.capabilities.events.records.query(input.sessionId, { last: 25 })
    : [];
  const trapLensTouchedPaths = sourceFamilies.includes("trap_lens")
    ? sessionAppliedTouchedFilePaths(input.runtime, input.sessionId)
    : [];
  const basisRefs = [
    ...sourceFamilies,
    ...skills.map((skill) => `skill:${skill.name}`),
    ...workbenchEntries.map((entry) => `workbench:${entry.id ?? entry.digest}`),
    ...recallDocuments.map((document) => document.id),
    ...tapeEvents.map((event) => `event:${event.id}`),
    ...input.searchRoots.map((root) => `root:${root}`),
    ...trapLensTouchedPaths.map((path) => `trap_lens_touched:${path}`),
  ];
  const generation = generationId({
    sessionId: input.sessionId,
    query: input.query,
    sourceFamilies,
    basisRefs,
  });
  const documents: AttentionOptionDocument[] = [];
  if (sourceFamilies.includes("skill_card")) {
    documents.push(...skills.map((skill) => skillToDocument(skill, generation)));
  }
  if (sourceFamilies.includes("workbench")) {
    documents.push(
      ...workbenchEntries.flatMap((entry) => workbenchToDocument(entry, generation) ?? []),
    );
  }
  if (
    sourceFamilies.includes("surfaced_recall") ||
    sourceFamilies.includes("repository_precedent")
  ) {
    if (sourceFamilies.includes("repository_precedent")) {
      documents.push(
        ...repositoryPrecedentDocuments({
          searchRoots: input.searchRoots,
          query: input.query,
          generation,
        }),
      );
    }
    documents.push(
      ...recallDocuments.map((document) => ({
        id: document.id,
        text: document.text,
        card: Object.assign({}, document.card, { generationId: generation }),
      })),
    );
  }
  if (sourceFamilies.includes("session_tape_evidence")) {
    documents.push(...recentTapeDocuments(tapeEvents, generation));
  }
  if (sourceFamilies.includes("trap_lens")) {
    documents.push(
      ...trapLensDocuments({
        runtime: input.runtime,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        generation,
      }),
    );
  }
  return { generation, documents: dedupeDocuments(documents) };
}

function dedupeDocuments(documents: readonly AttentionOptionDocument[]): AttentionOptionDocument[] {
  const deduped = new Map<string, AttentionOptionDocument>();
  for (const document of documents) {
    if (!deduped.has(document.id)) {
      deduped.set(document.id, document);
    }
  }
  return [...deduped.values()];
}

function selectCards(input: {
  readonly documents: readonly AttentionOptionDocument[];
  readonly query: string | null;
  readonly limit: number;
}): AttentionOptionProjection[] {
  if (!input.query) {
    return input.documents.slice(0, input.limit).map((document) => document.card);
  }
  const scored = scoreDocumentsByTfIdf(
    input.query,
    input.documents.map((document) => ({
      id: document.id,
      text: document.text,
      metadata: document,
    })),
    { limit: input.limit },
  );
  return scored
    .map((entry) => entry.document.metadata?.card)
    .filter((card): card is AttentionOptionProjection => Boolean(card));
}

function renderCards(cards: readonly AttentionOptionProjection[]): string {
  return [
    "# Attention Options",
    `results: ${cards.length}`,
    ...cards.map((card) =>
      [
        `- id=${card.optionId}`,
        `source=${card.sourceFamily}`,
        `title=${JSON.stringify(card.title)}`,
        `why=${JSON.stringify(card.whyRelevant)}`,
        `tokens=${card.tokenEstimate ?? "unknown"}`,
        `refs=${card.resourceRefs.join(",") || "none"}`,
        `authority=${card.authorityPosture}`,
      ].join(" | "),
    ),
  ].join("\n");
}

function recordAttentionMetric(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly action: AttentionOptionActionKind;
  readonly optionId: string;
  readonly reason?: string;
}): BrewvaEventRecord | undefined {
  return recordMetricObservation(input.runtime, input.sessionId, {
    metricKey: `attention.${input.action}`,
    value: 1,
    unit: "count",
    aggregation: "sum",
    evidenceRefs: [input.optionId],
    source: `attention_${input.action}`,
    optionId: input.optionId,
    reason: input.reason,
  });
}

function recordAttentionOptionsMetrics(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly generationId: string;
  readonly cards: readonly AttentionOptionProjection[];
}): void {
  const evidenceRefs = input.cards.map((card) => card.optionId);
  recordMetricObservation(input.runtime, input.sessionId, {
    metricKey: "attention.options_offered",
    value: input.cards.length,
    unit: "option",
    aggregation: "sum",
    evidenceRefs,
    source: "attention_options",
    generationId: input.generationId,
  });
  recordMetricObservation(input.runtime, input.sessionId, {
    metricKey: "attention.option_diversity",
    value: new Set(input.cards.map((card) => card.sourceFamily)).size,
    unit: "source_family",
    aggregation: "latest",
    evidenceRefs,
    source: "attention_options",
    generationId: input.generationId,
  });
}

function recordAttentionConsumeRatio(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly optionId: string;
}): void {
  const metrics = input.runtime.capabilities.events.iteration.listMetricObservations(
    input.sessionId,
  );
  const offered = metrics
    .filter((entry) => entry.metricKey === "attention.options_offered")
    .reduce((sum, entry) => sum + (Number.isFinite(entry.value) ? entry.value : 0), 0);
  const consumed = metrics
    .filter((entry) => entry.metricKey === "attention.consume")
    .reduce((sum, entry) => sum + (Number.isFinite(entry.value) ? entry.value : 0), 0);
  if (offered <= 0) {
    return;
  }
  recordMetricObservation(input.runtime, input.sessionId, {
    metricKey: "attention.option_consume_ratio",
    value: Math.min(1, consumed / offered),
    unit: "ratio",
    aggregation: "latest",
    evidenceRefs: [input.optionId],
    source: "attention_consume",
    optionId: input.optionId,
  });
}

/**
 * Re-derive a `trap_lens:<path>:<entry.id>` option id's content on explicit
 * consumption: re-read the file and re-run the shared match rather than
 * caching the lens body from card-generation time, so consumption always
 * reflects the file's CURRENT content — consistent with every other source
 * family here, none of which caches content across the options/consume
 * round trip. Splits on the LAST colon: entry ids are plain kebab-case
 * (never contain a colon), so this recovers the exact path even in the
 * unlikely event a workspace path itself contains one.
 */
function resolveTrapLensConsumedContent(
  workspaceRoot: string,
  optionId: string,
): {
  readonly title: string;
  readonly content: string;
  readonly refs: readonly string[];
  readonly sourceFamily: AttentionOptionSourceFamily;
} | null {
  const rest = optionId.slice("trap_lens:".length);
  const splitAt = rest.lastIndexOf(":");
  if (splitAt <= 0 || splitAt === rest.length - 1) {
    return null;
  }
  const path = rest.slice(0, splitAt);
  const entryId = rest.slice(splitAt + 1);
  const text = readTouchedFileTextOrNull(workspaceRoot, path);
  if (text === null) {
    return null;
  }
  const match = matchFileAgainstWriteVerifyTraps(text).find((entry) => entry.entry.id === entryId);
  if (!match) {
    return null;
  }
  return {
    title: match.entry.id,
    content: [`trap_id: ${match.entry.id}`, `file: ${path}`, `lens: ${match.lens}`].join("\n"),
    refs: [path],
    sourceFamily: "trap_lens",
  };
}

function resolveConsumedContent(input: {
  readonly runtime: BrewvaToolRuntime;
  readonly sessionId: string;
  readonly optionId: string;
  readonly workspaceRoot: string;
}): {
  readonly title: string;
  readonly content: string;
  readonly refs: readonly string[];
  readonly sourceFamily: AttentionOptionSourceFamily;
} | null {
  if (input.optionId.startsWith("trap_lens:")) {
    return resolveTrapLensConsumedContent(input.workspaceRoot, input.optionId);
  }
  if (input.optionId.startsWith("skill:")) {
    const name = input.optionId.slice("skill:".length);
    const skill = input.runtime.capabilities.skills.catalog.get(name);
    if (!skill) {
      return null;
    }
    return {
      title: skill.name,
      content: skill.markdown,
      refs: [
        skill.filePath,
        ...listSkillResourceRefs(skill).map((ref) => `${ref.kind}:${ref.path}`),
      ],
      sourceFamily: "skill_card",
    };
  }
  if (input.optionId.startsWith("workbench:")) {
    const stableRef = input.optionId.slice("workbench:".length);
    const entry = input.runtime.capabilities.workbench
      .list(input.sessionId)
      .find((candidate) => candidate.id === stableRef || candidate.digest === stableRef);
    if (!entry) {
      return null;
    }
    return {
      title: input.optionId,
      content: readNonEmptyString(entry.content) ?? readNonEmptyString(entry.text) ?? "",
      refs: entry.sourceRefs,
      sourceFamily: "workbench",
    };
  }
  const recallDocument = input.runtime.capabilities.events.records
    .query(input.sessionId, { type: RECALL_RESULTS_SURFACED_EVENT_TYPE })
    .flatMap((event) => readRecallResults(event, ["surfaced_recall", "repository_precedent"]))
    .find((document) => document.id === input.optionId);
  if (recallDocument) {
    return {
      title: recallDocument.card.title,
      content: [
        `stable_id: ${recallDocument.card.optionId}`,
        `source: ${recallDocument.card.sourceFamily}`,
        `root_ref: ${recallDocument.card.rootRef}`,
      ].join("\n"),
      refs: recallDocument.card.resourceRefs,
      sourceFamily: recallDocument.card.sourceFamily,
    };
  }
  if (input.optionId.startsWith("event:")) {
    const eventId = input.optionId.slice("event:".length);
    const event = input.runtime.capabilities.events.records
      .query(input.sessionId, { last: 100 })
      .find((candidate) => candidate.id === eventId);
    if (!event) {
      return null;
    }
    return {
      title: event.type,
      content: renderTapeEventSummary(event),
      refs: [input.optionId],
      sourceFamily: "session_tape_evidence",
    };
  }
  return null;
}

export function createAttentionOptionTools(options: BrewvaToolOptions): ToolDefinition[] {
  const attentionOptionsTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "attention_options",
  );
  const attentionConsumeTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "attention_consume",
  );
  const attentionPinTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "attention_pin");
  const attentionIgnoreTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "attention_ignore",
  );
  const attentionVerifyPlanTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "attention_verify_plan",
  );

  const attentionOptions = attentionOptionsTool.define({
    name: "attention_options",
    label: "Attention Options",
    description:
      "Return bounded advisory candidate cards for relevant context without reading full content.",
    promptGuidelines: [
      "Use this before consuming optional context. Cards are bounded and advisory.",
      "Use attention_consume with a selected option id to read content explicitly.",
      "Do not treat options as new authority; capability posture stays unchanged.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OPTION_CARDS })),
      sources: Type.Optional(Type.Array(ATTENTION_SOURCE_TYPES, { maxItems: 8 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = readNonEmptyString(params.query) ?? null;
      const sourceFamilies = readStringArray(params.sources).filter(isAttentionSourceFamily);
      const scope = resolveToolTargetScope(attentionOptionsTool.runtime, ctx);
      const workspaceRoot = resolveWorkspaceRoot(attentionOptionsTool.runtime, ctx);
      const { generation, documents } = collectOptionDocuments({
        runtime: attentionOptionsTool.runtime,
        sessionId,
        query,
        sourceFamilies,
        searchRoots: scope.allowedRoots,
        workspaceRoot,
      });
      const cards = selectCards({
        documents,
        query,
        limit: params.limit ?? 10,
      });
      recordAttentionOptionsMetrics({
        runtime: attentionOptionsTool.runtime,
        sessionId,
        generationId: generation,
        cards,
      });
      return okTextResult(renderCards(cards), {
        ok: true,
        schema: ATTENTION_OPTION_PROJECTION_SCHEMA_V1,
        generationId: generation,
        query,
        options: cards,
      });
    },
  });

  const attentionConsume = attentionConsumeTool.define({
    name: "attention_consume",
    label: "Attention Consume",
    description: "Explicitly consume one attention option and record the consumed ref.",
    parameters: Type.Object({
      option_id: Type.String({ minLength: 1, maxLength: 512 }),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const optionId = params.option_id.trim();
      const workspaceRoot = resolveWorkspaceRoot(attentionConsumeTool.runtime, ctx);
      const consumed = resolveConsumedContent({
        runtime: attentionConsumeTool.runtime,
        sessionId,
        optionId,
        workspaceRoot,
      });
      if (!consumed) {
        return errTextResult(`attention_consume could not resolve option ${optionId}.`, {
          ok: false,
          optionId,
          error: "unknown_option",
        });
      }
      const reason = readNonEmptyString(params.reason);
      const event = recordAttentionMetric({
        runtime: attentionConsumeTool.runtime,
        sessionId,
        action: "consume",
        optionId,
        reason,
      });
      recordAttentionConsumeRatio({
        runtime: attentionConsumeTool.runtime,
        sessionId,
        optionId,
      });
      const consumeReceiptEvent = recordAttentionConsumption(
        attentionConsumeTool.runtime,
        sessionId,
        {
          optionId,
          sourceFamily: consumed.sourceFamily,
          refs: [...consumed.refs],
          ...(reason ? { reason } : {}),
        },
      );
      const content = truncateText(consumed.content, MAX_CONSUMED_CHARS, { marker: "\n..." });
      return okTextResult(
        [
          "# Attention Consume",
          `option_id: ${optionId}`,
          `title: ${consumed.title}`,
          `refs: ${consumed.refs.join(",") || "none"}`,
          "",
          content,
        ].join("\n"),
        {
          ok: true,
          optionId,
          title: consumed.title,
          refs: consumed.refs,
          eventId: event?.id ?? null,
          metricEventId: event?.id ?? null,
          consumeReceiptEventId: consumeReceiptEvent?.id ?? null,
          truncated: content.length < consumed.content.length,
        },
      );
    },
  });

  const attentionPin = attentionPinTool.define({
    name: "attention_pin",
    label: "Attention Pin",
    description:
      "Pin one attention option into the workbench memory store with the attention_pin retention contract: the entry survives compaction and render eviction until you explicitly release it with workbench_evict (span ref entry:<id>).",
    parameters: Type.Object({
      option_id: Type.String({ minLength: 1, maxLength: 512 }),
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const optionId = params.option_id.trim();
      const reason = readNonEmptyString(params.reason) ?? ATTENTION_PIN_RETENTION_HINT;
      const entry = noteWorkbench(attentionPinTool.runtime, getSessionId(ctx), {
        content:
          readNonEmptyString(params.note) ??
          `Pinned attention option for explicit follow-up: ${optionId}`,
        sourceRefs: [optionId],
        reason,
        retentionHint: ATTENTION_PIN_RETENTION_HINT,
      });
      if (!entry) {
        return errTextResult("attention_pin unavailable (missing_runtime_workbench).", {
          ok: false,
          optionId,
          error: "missing_runtime_workbench",
        });
      }
      return okTextResult(`Attention option pinned (${entry.id ?? entry.digest}).`, {
        ok: true,
        optionId,
        entryId: entry.id ?? null,
        digest: entry.digest,
        sourceRefs: entry.sourceRefs,
      });
    },
  });

  const attentionIgnore = attentionIgnoreTool.define({
    name: "attention_ignore",
    label: "Attention Ignore",
    description: "Record a session-scoped advisory suppression for one attention option.",
    parameters: Type.Object({
      option_id: Type.String({ minLength: 1, maxLength: 512 }),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const optionId = params.option_id.trim();
      const event = recordAttentionMetric({
        runtime: attentionIgnoreTool.runtime,
        sessionId: getSessionId(ctx),
        action: "ignore",
        optionId,
        reason: readNonEmptyString(params.reason),
      });
      return okTextResult(`Attention option ignored for this session (${optionId}).`, {
        ok: true,
        optionId,
        scope: "session",
        eventId: event?.id ?? null,
      });
    },
  });

  const attentionVerifyPlan = attentionVerifyPlanTool.define({
    name: "attention_verify_plan",
    label: "Attention Verify Plan",
    description:
      "Return an advisory verification recipe for one attention option without reading files or running commands.",
    parameters: Type.Object({
      option_id: Type.String({ minLength: 1, maxLength: 512 }),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const optionId = params.option_id.trim();
      const objective = readNonEmptyString(params.objective) ?? "Validate the selected context.";
      const event = recordAttentionMetric({
        runtime: attentionVerifyPlanTool.runtime,
        sessionId: getSessionId(ctx),
        action: "verify_plan",
        optionId,
        reason: objective,
      });
      const recipe = [
        "# Attention Verify Plan",
        `option_id: ${optionId}`,
        `objective: ${objective}`,
        "1. Confirm the option ref is still relevant to the current user request.",
        "2. Check whether the work card already contains fresher authority, work, or evidence refs.",
        "3. If implementation depends on this option, consume it explicitly before acting.",
        "4. Treat any missing or stale evidence as advisory unless a verification gate manifest says otherwise.",
      ].join("\n");
      return okTextResult(recipe, {
        ok: true,
        optionId,
        eventId: event?.id ?? null,
        recipe,
        effects: {
          fs: false,
          command: false,
          provider: false,
          network: false,
        },
      });
    },
  });

  return [attentionOptions, attentionConsume, attentionPin, attentionIgnore, attentionVerifyPlan];
}
