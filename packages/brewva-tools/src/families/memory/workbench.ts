import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  listInvalidWorkbenchEvictionSpanRefs,
  type WorkbenchEntry,
} from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  evictWorkbench,
  noteWorkbench,
  undoWorkbenchEviction,
} from "../../runtime-port/workbench.js";
import { failTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => readNonEmptyString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function formatEntryHeader(entry: WorkbenchEntry): string {
  return [
    `id=${entry.id}`,
    `kind=${entry.kind}`,
    `digest=${entry.digest.slice(0, 12)}`,
    `created_turn=${entry.createdTurn}`,
    `reversible=${entry.reversible ? "true" : "false"}`,
  ].join(" | ");
}

export function createWorkbenchNoteTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "workbench_note",
  );
  return define({
    name: "workbench_note",
    label: "Workbench Note",
    description:
      "Write a model-authored working-memory notebook entry with source references and a reason.",
    promptSnippet:
      "Use this to preserve the active objective, decisions, user corrections, or salient evidence before compaction removes earlier context.",
    promptGuidelines: [
      "Write free-form notebook text around objective, current state, failed attempts, decisions, exact user corrections, or immediate next action.",
      "Use source_refs for quoted turns, file spans, tool-call ids, or event ids that support the note; do not write source-less memory.",
      "Keep notes dense and operational. Avoid restating visible history unless the note is about to replace an evicted span.",
      "When a large tool result has one durable lesson, write the lesson here and then evict the raw result with workbench_evict.",
    ],
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 8_000 }),
      source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        minItems: 1,
        maxItems: 32,
      }),
      reason: Type.String({ minLength: 1, maxLength: 1_000 }),
      retention_hint: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const content = readNonEmptyString(params.content);
      const reason = readNonEmptyString(params.reason);
      const sourceRefs = readStringList(params.source_refs);
      if (!content || !reason || sourceRefs.length === 0) {
        return failTextResult("workbench_note rejected (missing_content_reason_or_source_refs).", {
          ok: false,
          error: "missing_content_reason_or_source_refs",
        });
      }

      const retentionHint = readNonEmptyString(params.retention_hint);
      const entry = noteWorkbench(runtime, getSessionId(ctx), {
        content,
        sourceRefs,
        reason,
        ...(retentionHint ? { retentionHint } : {}),
      });
      if (!entry) {
        return failTextResult("workbench_note unavailable (missing_runtime_workbench).", {
          ok: false,
          error: "missing_runtime_workbench",
        });
      }

      return textResult(
        [
          "[WorkbenchNote]",
          formatEntryHeader(entry),
          `source_refs=${sourceRefs.length > 0 ? sourceRefs.join(", ") : "none"}`,
          `reason=${JSON.stringify(entry.reason)}`,
          "",
          entry.content,
        ].join("\n"),
        {
          ok: true,
          entryId: entry.id,
          kind: entry.kind,
          digest: entry.digest,
          sourceRefs: entry.sourceRefs,
          reason: entry.reason,
          retentionHint,
        },
      );
    },
  });
}

export function createWorkbenchEvictTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "workbench_evict",
  );
  return define({
    name: "workbench_evict",
    label: "Workbench Evict",
    description:
      "Evict stale context spans from active attention, optionally replacing them with a model-authored note.",
    promptSnippet:
      "Use this when raw history or tool output no longer deserves prompt space. Evictions stay reversible until the next baseline.",
    promptGuidelines: [
      "Evict by source span reference, not by vague topic. Use replacement_note when the dropped span contains a durable lesson.",
      "Preserve exact user corrections or task handoff quotes in preserved_quotes when they would otherwise be lost.",
      "Do not use this for external side effects. This only edits working attention.",
    ],
    parameters: Type.Object({
      span_refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        minItems: 1,
        maxItems: 64,
      }),
      replacement_note: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
      reason: Type.String({ minLength: 1, maxLength: 1_000 }),
      preserved_quotes: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
          maxItems: 16,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spanRefs = readStringList(params.span_refs);
      const reason = readNonEmptyString(params.reason);
      const invalidRefs = listInvalidWorkbenchEvictionSpanRefs(spanRefs);
      if (spanRefs.length === 0 || !reason || invalidRefs.length > 0) {
        return failTextResult("workbench_evict rejected (missing_span_refs_or_reason).", {
          ok: false,
          error: invalidRefs.length > 0 ? "invalid_span_refs" : "missing_span_refs_or_reason",
          invalidRefs,
        });
      }

      const replacementNote = readNonEmptyString(params.replacement_note);
      const preservedQuotes = readStringList(params.preserved_quotes);
      const entry = evictWorkbench(runtime, getSessionId(ctx), {
        spanRefs,
        ...(replacementNote ? { replacementNote } : {}),
        reason,
        preservedQuotes,
      });
      if (!entry) {
        return failTextResult("workbench_evict unavailable (missing_runtime_workbench).", {
          ok: false,
          error: "missing_runtime_workbench",
        });
      }

      return textResult(
        [
          "[WorkbenchEvict]",
          formatEntryHeader(entry),
          `span_refs=${spanRefs.join(", ")}`,
          `preserved_quotes=${preservedQuotes.length}`,
          `reason=${JSON.stringify(entry.reason)}`,
          ...(entry.content ? ["", entry.content] : []),
        ].join("\n"),
        {
          ok: true,
          entryId: entry.id,
          kind: entry.kind,
          digest: entry.digest,
          spanRefs: entry.sourceRefs,
          reason: entry.reason,
          reversible: entry.reversible,
          preservedQuotes: entry.preservedQuotes ?? [],
        },
      );
    },
  });
}

export function createWorkbenchUndoEvictTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "workbench_undo_evict",
  );
  return define({
    name: "workbench_undo_evict",
    label: "Workbench Undo Evict",
    description: "Undo a reversible workbench eviction before the next compact baseline.",
    promptSnippet:
      "Use this when new evidence shows a prior workbench_evict removed context that still matters.",
    promptGuidelines: [
      "Only undo eviction entries whose reversible field is true.",
      "State why the evicted span needs active attention again.",
      "After a compact baseline, evictions are no longer reversible.",
    ],
    parameters: Type.Object({
      entry_id: Type.String({ minLength: 1, maxLength: 256 }),
      reason: Type.String({ minLength: 1, maxLength: 1_000 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entryId = readNonEmptyString(params.entry_id);
      const reason = readNonEmptyString(params.reason);
      if (!entryId || !reason) {
        return failTextResult("workbench_undo_evict rejected (missing_entry_id_or_reason).", {
          ok: false,
          error: "missing_entry_id_or_reason",
        });
      }

      const result = undoWorkbenchEviction(runtime, getSessionId(ctx), entryId, reason);
      if (!result) {
        return failTextResult("workbench_undo_evict unavailable (missing_runtime_workbench).", {
          ok: false,
          error: "missing_runtime_workbench",
        });
      }
      if (!result.undone || !result.entry) {
        return failTextResult("workbench_undo_evict rejected (not_reversible_or_missing).", {
          ok: false,
          error: "not_reversible_or_missing",
          entryId,
        });
      }

      return textResult(
        [
          "[WorkbenchUndoEvict]",
          formatEntryHeader(result.entry),
          `reason=${JSON.stringify(reason)}`,
        ].join("\n"),
        {
          ok: true,
          entryId: result.entry.id,
          digest: result.entry.digest,
          undoneAtTurn: result.entry.undoneAtTurn,
          reason,
        },
      );
    },
  });
}
