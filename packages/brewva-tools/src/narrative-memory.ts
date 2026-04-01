import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_RECORD_STATUSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
  getOrCreateNarrativeMemoryPlane,
  resolveNarrativeMemoryHeadingForClass,
  validateNarrativeMemoryCandidate,
  type NarrativeMemoryRecord,
  type NarrativeMemoryState,
} from "@brewva/brewva-deliberation";
import {
  NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
  NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
  NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
  NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
  NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { shouldInvokeSemanticRerank } from "./semantic-oracle.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ACTION_VALUES = [
  "list",
  "show",
  "retrieve",
  "stats",
  "remember",
  "review",
  "promote",
  "archive",
  "forget",
] as const;
const REVIEW_DECISION_VALUES = ["accept", "reject"] as const;

const ActionSchema = buildStringEnumSchema(ACTION_VALUES, {});
const ClassSchema = buildStringEnumSchema(NARRATIVE_MEMORY_RECORD_CLASSES, {});
const StatusSchema = buildStringEnumSchema(NARRATIVE_MEMORY_RECORD_STATUSES, {});
const ScopeSchema = buildStringEnumSchema(NARRATIVE_MEMORY_SCOPE_VALUES, {});
const ReviewDecisionSchema = buildStringEnumSchema(REVIEW_DECISION_VALUES, {});

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readRecordClass(
  value: unknown,
): (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_RECORD_CLASSES.includes(
      value as (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number],
    )
    ? (value as (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number])
    : undefined;
}

function readRecordStatus(
  value: unknown,
): (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_RECORD_STATUSES.includes(
      value as (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number],
    )
    ? (value as (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number])
    : undefined;
}

function readScope(value: unknown): (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_SCOPE_VALUES.includes(value as (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number])
    ? (value as (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number])
    : undefined;
}

function readDecision(value: unknown): (typeof REVIEW_DECISION_VALUES)[number] | undefined {
  return typeof value === "string" &&
    REVIEW_DECISION_VALUES.includes(value as (typeof REVIEW_DECISION_VALUES)[number])
    ? (value as (typeof REVIEW_DECISION_VALUES)[number])
    : undefined;
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendLifecycleHistory(
  record: NarrativeMemoryRecord,
  entry: {
    action: "review" | "archive" | "forget" | "promote";
    fromStatus: NarrativeMemoryRecord["status"];
    toStatus: NarrativeMemoryRecord["status"];
    sessionId: string;
    agentId: string;
    decision?: "accept" | "reject";
  },
): Record<string, unknown> {
  const currentMetadata = isRecord(record.metadata) ? record.metadata : {};
  const historySeed = Array.isArray(currentMetadata.lifecycleHistory)
    ? currentMetadata.lifecycleHistory.filter(isRecord)
    : [];
  const lifecycleHistory = [
    ...historySeed,
    {
      action: entry.action,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      decision: entry.decision ?? null,
      timestamp: Date.now(),
    },
  ].slice(-12);

  return {
    ...currentMetadata,
    lifecycleHistory,
  };
}

function defaultScopeForClass(recordClass: (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number]) {
  switch (recordClass) {
    case "operator_preference":
      return "operator";
    case "working_convention":
      return "agent";
    case "project_context_note":
    case "external_reference_note":
      return "repository";
    default:
      return "repository";
  }
}

function formatRecordSummary(record: NarrativeMemoryRecord): string {
  return [
    `- ${record.id}`,
    `  class=${record.class}`,
    `  status=${record.status}`,
    `  scope=${record.applicabilityScope}`,
    `  confidence=${record.confidenceScore.toFixed(2)}`,
    `  retrieval_count=${record.retrievalCount}`,
    `  updated_at=${new Date(record.updatedAt).toISOString()}`,
    `  title=${record.title}`,
    `  summary=${record.summary}`,
  ].join("\n");
}

function formatRecordDetail(record: NarrativeMemoryRecord): string {
  const lines = [
    "# Narrative Memory",
    `id: ${record.id}`,
    `class: ${record.class}`,
    `status: ${record.status}`,
    `scope: ${record.applicabilityScope}`,
    `confidence_score: ${record.confidenceScore.toFixed(2)}`,
    `created_at: ${new Date(record.createdAt).toISOString()}`,
    `updated_at: ${new Date(record.updatedAt).toISOString()}`,
    `retrieval_count: ${record.retrievalCount}`,
    `last_retrieved_at: ${
      record.lastRetrievedAt ? new Date(record.lastRetrievedAt).toISOString() : "none"
    }`,
    "",
    "## Title",
    record.title,
    "",
    "## Summary",
    record.summary,
    "",
    "## Content",
    record.content,
    "",
    "## Provenance",
    `source: ${record.provenance.source}`,
    `actor: ${record.provenance.actor}`,
    `session_id: ${record.provenance.sessionId ?? "none"}`,
    `agent_id: ${record.provenance.agentId ?? "none"}`,
    `turn: ${record.provenance.turn ?? "none"}`,
    `target_roots: ${record.provenance.targetRoots.join(", ") || "none"}`,
  ];

  if (record.promotionTarget) {
    lines.push(
      "",
      "## Promotion Target",
      `agent_id: ${record.promotionTarget.agentId}`,
      `path: ${record.promotionTarget.path}`,
      `heading: ${record.promotionTarget.heading}`,
      `promoted_at: ${new Date(record.promotionTarget.promotedAt).toISOString()}`,
    );
  }

  if (record.evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const evidence of record.evidence.slice(0, 10)) {
      lines.push(
        `- kind=${evidence.kind} session=${evidence.sessionId} tool=${evidence.toolName ?? "none"} event=${evidence.eventId ?? "none"} at=${new Date(evidence.timestamp).toISOString()} summary=${evidence.summary}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatStats(state: NarrativeMemoryState): string {
  const classCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();

  for (const record of state.records) {
    classCounts.set(record.class, (classCounts.get(record.class) ?? 0) + 1);
    statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
    scopeCounts.set(
      record.applicabilityScope,
      (scopeCounts.get(record.applicabilityScope) ?? 0) + 1,
    );
  }

  const renderMap = (values: Map<string, number>, orderedKeys?: readonly string[]) =>
    (orderedKeys ?? [...values.keys()].toSorted())
      .map((key) => `${key}=${values.get(key) ?? 0}`)
      .join(", ") || "none";

  return [
    "# Narrative Memory Stats",
    `updated_at: ${new Date(state.updatedAt).toISOString()}`,
    `records: ${state.records.length}`,
    `classes: ${renderMap(classCounts, NARRATIVE_MEMORY_RECORD_CLASSES)}`,
    `statuses: ${renderMap(statusCounts, NARRATIVE_MEMORY_RECORD_STATUSES)}`,
    `scopes: ${renderMap(scopeCounts, NARRATIVE_MEMORY_SCOPE_VALUES)}`,
  ].join("\n");
}

function createMemoryScaffold(): string {
  return [
    "# Memory",
    "",
    "## Stable Memory",
    "- Capture durable operator preferences and recurring constraints here.",
    "",
    "## Operator Preferences",
    "- Record collaboration style, risk posture, and review expectations.",
    "",
    "## Continuity Notes",
    "- Keep this non-authoritative. Promote only durable patterns, not transient plans.",
    "",
  ].join("\n");
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBulletText(value: string): string {
  return value
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureAgentMemoryFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
    const scaffold = `${createMemoryScaffold()}\n`;
    await writeFile(path, scaffold, "utf8");
    return scaffold;
  }
}

function appendBulletToHeading(markdown: string, heading: string, bullet: string): string {
  const normalizedBullet = normalizeBulletText(bullet);
  const bulletLine = `- ${normalizedBullet}`;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  const existingBullet = lines.some((line) => normalizeBulletText(line) === normalizedBullet);
  if (existingBullet) {
    return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  }

  let headingIndex = lines.findIndex(
    (line) =>
      /^##\s+/u.test(line) &&
      normalizeHeading(line.replace(/^##\s+/u, "")) === normalizeHeading(heading),
  );

  if (headingIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
      lines.push("");
    }
    lines.push(`## ${heading}`, bulletLine, "");
    return `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`;
  }

  let insertIndex = headingIndex + 1;
  let nextHeadingIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? "")) {
      nextHeadingIndex = index;
      break;
    }
  }
  for (let index = headingIndex + 1; index < nextHeadingIndex; index += 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      insertIndex = index + 1;
    }
  }
  lines.splice(insertIndex, 0, bulletLine);
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

async function promoteRecordToAgentMemory(input: {
  workspaceRoot: string;
  agentId: string;
  record: NarrativeMemoryRecord;
}): Promise<{ path: string; heading: string }> {
  const path = resolve(input.workspaceRoot, ".brewva", "agents", input.agentId, "memory.md");
  const heading = resolveNarrativeMemoryHeadingForClass(input.record.class);
  const current = await ensureAgentMemoryFile(path);
  const next = appendBulletToHeading(current, heading, input.record.content);
  if (next !== current) {
    await writeFile(path, next, "utf8");
  }
  return { path, heading };
}

export function createNarrativeMemoryTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "narrative_memory",
    label: "Narrative Memory",
    description:
      "Inspect and manage typed narrative memory records without widening kernel authority or conflating them with repository precedent.",
    promptSnippet:
      "Use this to review, promote, or inspect collaboration memory explicitly instead of assuming hidden long-term recall.",
    promptGuidelines: [
      "Remember stores non-authoritative collaboration semantics, not kernel truth or repository precedent.",
      "Capture validated positive guidance as well as corrections when the turn teaches a reusable collaboration rule.",
      "For operator_preference and working_convention, lead with the rule and include Why:/How to apply: lines when that context is known.",
      "For project_context_note, convert relative dates into explicit ISO dates so the note survives time passing.",
      "Promote writes durable narrative notes into the agent self-bundle memory.md, not docs/solutions/.",
    ],
    parameters: Type.Object({
      action: ActionSchema,
      record_id: Type.Optional(Type.String({ minLength: 1 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
      class: Type.Optional(ClassSchema),
      status: Type.Optional(StatusSchema),
      scope: Type.Optional(ScopeSchema),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      decision: Type.Optional(ReviewDecisionSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      agent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const plane = getOrCreateNarrativeMemoryPlane(options.runtime);
      const recordClass = readRecordClass(params.class);
      const status = readRecordStatus(params.status);
      const scope = readScope(params.scope);
      const recordId = readTrimmedString(params.record_id);
      const query = readTrimmedString(params.query);
      const limit = Math.max(1, Math.min(20, params.limit ?? 10));
      const targetRoots = options.runtime.task.getTargetDescriptor(sessionId).roots;

      if (params.action === "stats") {
        const state = plane.getState();
        return textResult(formatStats(state), {
          ok: true,
          recordCount: state.records.length,
        });
      }

      if (params.action === "list") {
        const records = plane.list({
          class: recordClass,
          status,
          applicabilityScope: scope,
          limit,
        });
        if (records.length === 0) {
          return inconclusiveTextResult("No narrative memory records match the current filter.", {
            ok: false,
            class: recordClass ?? null,
            status: status ?? null,
            scope: scope ?? null,
            records: [],
          });
        }
        return textResult(
          [
            "# Narrative Memory Records",
            `count: ${records.length}`,
            ...records.map(formatRecordSummary),
          ].join("\n"),
          {
            ok: true,
            class: recordClass ?? null,
            status: status ?? null,
            scope: scope ?? null,
            records,
          },
        );
      }

      if (params.action === "show") {
        if (!recordId) {
          return failTextResult("show requires record_id.", {
            ok: false,
            error: "missing_record_id",
          });
        }
        const record = plane.getRecord(recordId);
        if (!record) {
          return inconclusiveTextResult(`Narrative memory record '${recordId}' was not found.`, {
            ok: false,
            recordId,
          });
        }
        return textResult(formatRecordDetail(record), {
          ok: true,
          record,
        });
      }

      if (params.action === "retrieve") {
        if (!query) {
          return failTextResult("retrieve requires query.", {
            ok: false,
            error: "missing_query",
          });
        }
        let retrievals = plane
          .retrieve(query, {
            limit: Math.max(limit * 3, limit),
            targetRoots,
            statuses: status ? [status] : ["active", "promoted"],
            recordRetrieval: false,
          })
          .filter((entry) => !recordClass || entry.record.class === recordClass)
          .filter((entry) => !scope || entry.record.applicabilityScope === scope);

        const oracle = options.runtime.semanticOracle;
        if (
          retrievals.length >= 3 &&
          oracle?.rerankNarrativeMemory &&
          shouldInvokeSemanticRerank(retrievals.map((entry) => entry.score))
        ) {
          const reranked = await oracle.rerankNarrativeMemory({
            sessionId,
            surface: "narrative_memory",
            query,
            targetRoots,
            candidates: retrievals.map((entry) => ({
              id: entry.record.id,
              title: entry.record.title,
              summary: entry.record.summary,
              content: entry.record.content,
              kind: entry.record.class,
              scope: entry.record.applicabilityScope,
            })),
            stateRevision: String(plane.getState().updatedAt),
          });
          if (reranked) {
            const byId = new Map(retrievals.map((entry) => [entry.record.id, entry] as const));
            retrievals = reranked.orderedIds
              .map((id) => byId.get(id))
              .filter((entry): entry is (typeof retrievals)[number] => Boolean(entry));
          }
        }

        retrievals = retrievals.slice(0, limit);
        if (retrievals.length === 0) {
          return inconclusiveTextResult(
            "No narrative memory records matched the retrieval query.",
            {
              ok: false,
              query,
              class: recordClass ?? null,
              status: status ?? null,
              scope: scope ?? null,
              retrievals: [],
            },
          );
        }
        plane.markRetrieved(retrievals.map((entry) => entry.record.id));
        return textResult(
          [
            "# Narrative Memory Retrieval",
            `count: ${retrievals.length}`,
            ...retrievals.map(
              (entry) =>
                `${formatRecordSummary(entry.record)}\n  retrieval_score=${entry.score.toFixed(2)}\n  matched_terms=${
                  entry.matchedTerms.join(", ") || "none"
                }`,
            ),
          ].join("\n"),
          {
            ok: true,
            query,
            retrievals,
          },
        );
      }

      if (params.action === "remember") {
        if (!recordClass) {
          return failTextResult("remember requires class.", {
            ok: false,
            error: "missing_class",
          });
        }
        const title = readTrimmedString(params.title);
        const content = readTrimmedString(params.content);
        if (!title || !content) {
          return failTextResult("remember requires title and content.", {
            ok: false,
            error: "missing_title_or_content",
          });
        }
        const applicabilityScope = scope ?? defaultScopeForClass(recordClass);
        const validation = validateNarrativeMemoryCandidate({
          workspaceRoot: options.runtime.workspaceRoot,
          agentId: options.runtime.agentId,
          plane,
          candidate: {
            class: recordClass,
            title,
            content,
            applicabilityScope,
          },
        });
        if (!validation.ok && validation.code === "duplicate_record") {
          return inconclusiveTextResult(validation.message, {
            ok: false,
            error: validation.code,
            duplicates: validation.duplicates ?? [],
          });
        }
        if (!validation.ok) {
          return failTextResult(validation.message, {
            ok: false,
            error: validation.code,
          });
        }
        const summary = readTrimmedString(params.summary) ?? compactText(content, 180);
        const record = plane.addRecord({
          class: recordClass,
          title,
          summary,
          content,
          applicabilityScope,
          confidenceScore: params.confidence ?? 1,
          status: "active",
          retrievalCount: 0,
          provenance: {
            source: "explicit_tool",
            actor: "operator",
            sessionId,
            agentId: options.runtime.agentId,
            targetRoots,
          },
          evidence: [
            {
              kind: "input_excerpt",
              summary: compactText(content, 220),
              sessionId,
              timestamp: Date.now(),
            },
          ],
        });
        options.runtime.events.record({
          sessionId,
          type: NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
          payload: {
            recordId: record.id,
            recordClass: record.class,
            status: record.status,
            provenanceSource: record.provenance.source,
          },
        });
        return textResult(formatRecordDetail(record), {
          ok: true,
          record,
        });
      }

      if (params.action === "review") {
        if (!recordId) {
          return failTextResult("review requires record_id.", {
            ok: false,
            error: "missing_record_id",
          });
        }
        const decision = readDecision(params.decision);
        if (!decision) {
          return failTextResult("review requires decision.", {
            ok: false,
            error: "missing_decision",
          });
        }
        const existing = plane.getRecord(recordId);
        if (!existing) {
          return inconclusiveTextResult(`Narrative memory record '${recordId}' was not found.`, {
            ok: false,
            recordId,
          });
        }
        if (existing.status !== "proposed") {
          return failTextResult("review only applies to proposed narrative memory records.", {
            ok: false,
            error: "invalid_status_transition",
            recordId,
            status: existing.status,
          });
        }
        const updated = plane.updateRecord(recordId, (current) => ({
          ...current,
          status: decision === "accept" ? "active" : "rejected",
          metadata: appendLifecycleHistory(current, {
            action: "review",
            fromStatus: current.status,
            toStatus: decision === "accept" ? "active" : "rejected",
            decision,
            sessionId,
            agentId: options.runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("review failed to update record state.", {
            ok: false,
            error: "review_state_update_failed",
            recordId,
          });
        }
        options.runtime.events.record({
          sessionId,
          type: NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
          payload: {
            recordId: updated.id,
            decision,
            previousStatus: existing.status,
            status: updated.status,
            provenanceSource: updated.provenance.source,
          },
        });
        return textResult(formatRecordDetail(updated), {
          ok: true,
          decision,
          record: updated,
        });
      }

      if (params.action === "archive") {
        if (!recordId) {
          return failTextResult("archive requires record_id.", {
            ok: false,
            error: "missing_record_id",
          });
        }
        const existing = plane.getRecord(recordId);
        if (!existing) {
          return inconclusiveTextResult(`Narrative memory record '${recordId}' was not found.`, {
            ok: false,
            recordId,
          });
        }
        if (existing.status !== "active") {
          return failTextResult("archive only applies to active narrative memory records.", {
            ok: false,
            error: "invalid_status_transition",
            recordId,
            status: existing.status,
          });
        }
        const updated = plane.updateRecord(recordId, (current) => ({
          ...current,
          status: "archived",
          metadata: appendLifecycleHistory(current, {
            action: "archive",
            fromStatus: current.status,
            toStatus: "archived",
            sessionId,
            agentId: options.runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("archive failed to update record state.", {
            ok: false,
            error: "archive_state_update_failed",
            recordId,
          });
        }
        options.runtime.events.record({
          sessionId,
          type: NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
          payload: {
            recordId: updated.id,
            previousStatus: existing.status,
            status: updated.status,
          },
        });
        return textResult(formatRecordDetail(updated), {
          ok: true,
          record: updated,
        });
      }

      if (params.action === "forget") {
        if (!recordId) {
          return failTextResult("forget requires record_id.", {
            ok: false,
            error: "missing_record_id",
          });
        }
        const existing = plane.getRecord(recordId);
        if (!existing) {
          return inconclusiveTextResult(`Narrative memory record '${recordId}' was not found.`, {
            ok: false,
            recordId,
          });
        }
        if (existing.status !== "proposed" && existing.status !== "active") {
          return failTextResult(
            "forget only applies to proposed or active narrative memory records.",
            {
              ok: false,
              error: "invalid_status_transition",
              recordId,
              status: existing.status,
            },
          );
        }
        const updated = plane.updateRecord(recordId, (current) => ({
          ...current,
          status: "rejected",
          metadata: appendLifecycleHistory(current, {
            action: "forget",
            fromStatus: current.status,
            toStatus: "rejected",
            sessionId,
            agentId: options.runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("forget failed to update record state.", {
            ok: false,
            error: "forget_state_update_failed",
            recordId,
          });
        }
        options.runtime.events.record({
          sessionId,
          type: NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
          payload: {
            recordId: updated.id,
            previousStatus: existing.status,
            status: updated.status,
          },
        });
        return textResult(formatRecordDetail(updated), {
          ok: true,
          record: updated,
        });
      }

      if (!recordId) {
        return failTextResult("promote requires record_id.", {
          ok: false,
          error: "missing_record_id",
        });
      }
      const record = plane.getRecord(recordId);
      if (!record) {
        return inconclusiveTextResult(`Narrative memory record '${recordId}' was not found.`, {
          ok: false,
          recordId,
        });
      }
      if (record.status !== "active") {
        return failTextResult("promote only applies to active narrative memory records.", {
          ok: false,
          error: "invalid_status_transition",
          recordId,
          status: record.status,
        });
      }
      const targetAgentId = readTrimmedString(params.agent_id) ?? options.runtime.agentId;
      const promotion = await promoteRecordToAgentMemory({
        workspaceRoot: options.runtime.workspaceRoot,
        agentId: targetAgentId,
        record,
      });
      const updated = plane.updateRecord(record.id, (current) => ({
        ...current,
        status: "promoted",
        metadata: appendLifecycleHistory(current, {
          action: "promote",
          fromStatus: current.status,
          toStatus: "promoted",
          sessionId,
          agentId: options.runtime.agentId,
        }),
        promotionTarget: {
          agentId: targetAgentId,
          path: promotion.path,
          heading: promotion.heading,
          promotedAt: Date.now(),
        },
      }));
      if (!updated) {
        return failTextResult("promote failed to update record state.", {
          ok: false,
          error: "promotion_state_update_failed",
        });
      }
      options.runtime.events.record({
        sessionId,
        type: NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
        payload: {
          recordId: updated.id,
          previousStatus: record.status,
          agentId: targetAgentId,
          path: promotion.path,
          heading: promotion.heading,
        },
      });
      return textResult(formatRecordDetail(updated), {
        ok: true,
        record: updated,
        promotion,
      });
    },
  });
}
