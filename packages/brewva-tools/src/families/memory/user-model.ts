import {
  getOrCreateRecallBroker,
  isRecallSessionIndexUnavailable,
} from "@brewva/brewva-recall/broker";
import { normalizeStringList, readNonEmptyString } from "@brewva/brewva-std/text";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  USER_FACT_SCOPES,
  type UserFactScope,
  type UserModelProjection,
} from "@brewva/brewva-vocabulary/user-model";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { resolveRecallBrokerRuntime } from "../../runtime-port/recall.js";
import { recordUserFact } from "../../runtime-port/workbench.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

// A user fact is model-authored advisory material folded into the user-model projection:
// it grants no capability, routes no model, and bypasses no gate (axioms 11, 18). The
// honesty grade is system-assigned (`estimated` on authoring, promoted by corroboration in
// a later phase), never the model asserting certainty — so it is not a tool parameter.
export function createUserFactTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "user_fact");
  return define({
    name: "user_fact",
    label: "User Fact",
    description:
      "Record a durable advisory fact about the user (a preference, role, or standing constraint) onto the tape for later sessions.",
    promptSnippet:
      "Use this when you conclude a lasting fact about the user worth carrying across sessions. Advisory only: it grants nothing and changes no gate.",
    promptGuidelines: [
      "Author a fact only when you have actually concluded one — a stated preference, a correction, a standing constraint — never a guess.",
      "Use a stable lowercase fact_key (e.g. communication_style, preferred_language) so a later revision supersedes the same key latest-wins.",
      "scope=user for a global trait; scope=project for a constraint specific to this repository.",
      "Cite source_refs (turn/message/event ids) for the evidence; pass supersedes_id when revising a specific prior fact.",
    ],
    parameters: Type.Object({
      fact_key: Type.String({ minLength: 1, maxLength: 128 }),
      value: Type.String({ minLength: 1, maxLength: 2_000 }),
      scope: Type.Optional(
        Type.Union(
          USER_FACT_SCOPES.map((scope) => Type.Literal(scope)),
          { default: "user" },
        ),
      ),
      reason: Type.String({ minLength: 1, maxLength: 1_000 }),
      source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        minItems: 1,
        maxItems: 32,
      }),
      supersedes_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const factKey = readNonEmptyString(params.fact_key);
      const value = readNonEmptyString(params.value);
      const reason = readNonEmptyString(params.reason);
      const sourceRefs = [...new Set(normalizeStringList(params.source_refs))];
      if (!factKey || !value || !reason || sourceRefs.length === 0) {
        return errTextResult("user_fact rejected (missing_fact_key_value_reason_or_source_refs).", {
          ok: false,
          error: "missing_fact_key_value_reason_or_source_refs",
        });
      }

      const scope: UserFactScope = params.scope ?? "user";
      const supersedesId = readNonEmptyString(params.supersedes_id);
      const entry = recordUserFact(runtime, getSessionId(ctx), {
        scope,
        factKey,
        value,
        reason,
        sourceRefs,
        ...(supersedesId ? { supersedesId } : {}),
      });
      if (!entry) {
        return errTextResult("user_fact unavailable (missing_runtime_workbench).", {
          ok: false,
          error: "missing_runtime_workbench",
        });
      }

      return okTextResult(
        [
          "[UserFact]",
          `id=${entry.id} | scope=${entry.scope} | fact_key=${entry.factKey} | grade=${entry.grade}`,
          `reason=${JSON.stringify(entry.reason)}`,
          "",
          entry.value,
        ].join("\n"),
        {
          ok: true,
          entryId: entry.id,
          scope: entry.scope,
          factKey: entry.factKey,
          grade: entry.grade,
          sourceRefs: entry.sourceRefs,
        },
      );
    },
  });
}

// Explicit-pull retrieval of the user model: it returns the folded facts only when called
// and reveals nothing on its own (no auto-injection, axiom 1). Opening the surface — its
// mere registration — adds zero prompt bytes; the tool call is the only reveal. The model is
// folded cross-session from the tape via the recall broker, the same surface recall_search
// pulls (grades calibrated from independent sessions); an unavailable index is reported, not
// silently degraded.
export function createUserModelTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "user_model");
  return define({
    name: "user_model",
    label: "User Model",
    description:
      "Pull the current user model — the durable advisory facts recorded about the user, folded latest-wins from the tape. Read-only and explicit-pull.",
    promptSnippet:
      "Use this to recall durable user facts (preferences, role, standing constraints) that may have fallen out of context. It reveals nothing on its own.",
    promptGuidelines: [
      "An explicit pull: it returns the current user model only when called, and injects nothing on its own.",
      "Facts are advisory evidence with a measured/estimated/inconclusive grade; the grade gates nothing.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(Type.Union(USER_FACT_SCOPES.map((scope) => Type.Literal(scope)))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      // The cross-session user model is folded by the recall broker from the session index —
      // the same surface recall_search pulls, inheriting its next-turn cache warming. When the
      // index is unavailable the tool reports it (like recall_search) rather than silently
      // degrading to a session-local view that would read as the full cross-session model.
      let model: UserModelProjection;
      try {
        model = await getOrCreateRecallBroker(resolveRecallBrokerRuntime(runtime)).userModel({
          sessionId,
        });
      } catch (error) {
        if (isRecallSessionIndexUnavailable(error)) {
          const message = error instanceof Error ? error.message : String(error);
          return errTextResult(`user_model unavailable (session_index_unavailable): ${message}`, {
            ok: false,
            error: "session_index_unavailable",
            message,
          });
        }
        throw error;
      }
      const facts = params.scope
        ? model.facts.filter((fact) => fact.scope === params.scope)
        : model.facts;
      return okTextResult(
        facts.length === 0
          ? "[UserModel] (no user facts recorded yet)"
          : [
              "[UserModel]",
              ...facts.map(
                (fact) => `- ${fact.scope}/${fact.factKey} [${fact.grade}]: ${fact.value}`,
              ),
            ].join("\n"),
        {
          ok: true,
          count: facts.length,
          // Full provenance in the structured payload (user_model doubles as the audit/inspect
          // surface): why the fact was authored, its evidence refs, the entry that authored the
          // current value, and the superseded chain. The text stays terse; a consumer that
          // needs the audit trail reads the structured facts.
          facts: facts.map((fact) => ({
            scope: fact.scope,
            factKey: fact.factKey,
            value: fact.value,
            grade: fact.grade,
            entryId: fact.entryId,
            reason: fact.reason,
            sourceRefs: [...fact.sourceRefs],
            supersededEntryIds: [...fact.supersededEntryIds],
            createdAt: fact.createdAt,
            updatedAt: fact.updatedAt,
          })),
        },
      );
    },
  });
}
