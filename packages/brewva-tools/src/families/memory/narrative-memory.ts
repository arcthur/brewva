import {
  getOrCreateNarrativeMemoryPlane,
  validateNarrativeMemoryCandidate,
} from "@brewva/brewva-deliberation";
import {
  NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
  NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
  NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
  NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
  NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { recordToolRuntimeEvent } from "../../runtime-port/extensions.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";
import { readMemoryToolString, resolveMemoryToolLimit } from "./internal/memory-plane-tool.js";
import { appendLifecycleHistory } from "./narrative-memory/lifecycle.js";
import { promoteRecordToAgentMemory } from "./narrative-memory/promotion.js";
import { formatRecordDetail, formatRecordSummary, formatStats } from "./narrative-memory/render.js";
import { retrieveNarrativeMemoryRecords } from "./narrative-memory/retrieve.js";
import {
  ActionSchema,
  ClassSchema,
  ReviewDecisionSchema,
  ScopeSchema,
  StatusSchema,
  compactText,
  defaultScopeForClass,
  readDecision,
  readRecordClass,
  readRecordStatus,
  readScope,
} from "./narrative-memory/schema.js";

export function createNarrativeMemoryTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "narrative_memory",
  );
  return define({
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
      const plane = getOrCreateNarrativeMemoryPlane(runtime);
      const recordClass = readRecordClass(params.class);
      const status = readRecordStatus(params.status);
      const scope = readScope(params.scope);
      const recordId = readMemoryToolString(params.record_id);
      const query = readMemoryToolString(params.query);
      const limit = resolveMemoryToolLimit(params.limit);
      const targetRoots = runtime.inspect.task.getTargetDescriptor(sessionId).roots;

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
        return await retrieveNarrativeMemoryRecords({
          plane,
          runtime,
          sessionId,
          query,
          recordClass,
          status,
          scope,
          limit,
          targetRoots,
        });
      }

      if (params.action === "remember") {
        if (!recordClass) {
          return failTextResult("remember requires class.", {
            ok: false,
            error: "missing_class",
          });
        }
        const title = readMemoryToolString(params.title);
        const content = readMemoryToolString(params.content);
        if (!title || !content) {
          return failTextResult("remember requires title and content.", {
            ok: false,
            error: "missing_title_or_content",
          });
        }
        const applicabilityScope = scope ?? defaultScopeForClass(recordClass);
        const validation = validateNarrativeMemoryCandidate({
          workspaceRoot: runtime.workspaceRoot,
          agentId: runtime.agentId,
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
        const summary = readMemoryToolString(params.summary) ?? compactText(content, 180);
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
            agentId: runtime.agentId,
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
        recordToolRuntimeEvent(runtime, {
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
            agentId: runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("review failed to update record state.", {
            ok: false,
            error: "review_state_update_failed",
            recordId,
          });
        }
        recordToolRuntimeEvent(runtime, {
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
            agentId: runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("archive failed to update record state.", {
            ok: false,
            error: "archive_state_update_failed",
            recordId,
          });
        }
        recordToolRuntimeEvent(runtime, {
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
            agentId: runtime.agentId,
          }),
        }));
        if (!updated) {
          return failTextResult("forget failed to update record state.", {
            ok: false,
            error: "forget_state_update_failed",
            recordId,
          });
        }
        recordToolRuntimeEvent(runtime, {
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
      const targetAgentId = readMemoryToolString(params.agent_id) ?? runtime.agentId;
      const promotion = await promoteRecordToAgentMemory({
        workspaceRoot: runtime.workspaceRoot,
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
          agentId: runtime.agentId,
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
      recordToolRuntimeEvent(runtime, {
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
