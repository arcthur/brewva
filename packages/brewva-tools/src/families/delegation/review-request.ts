import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { DelegationReviewDispatch } from "@brewva/brewva-vocabulary/delegation";
import { Type } from "@sinclair/typebox";
import type {
  BrewvaToolOptions,
  BrewvaToolRuntime,
  SubagentRunRequest,
} from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { resolveWorkspaceRoot } from "../../runtime-port/session-touched-files.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";
import { commitReviewReceipts, resolveRoutedModel } from "./review-receipts.js";
import {
  buildReviewPacket,
  buildReviewResultText,
  resolveAtomsForTarget,
  resolveFoldedDebtAtoms,
  snapshotTargetRef,
  type ReviewParams,
  type ReviewTarget,
} from "./review-request-packet.js";
import { resolveWaitMode } from "./subagent-run/packet-builder.js";

/**
 * The default open adversarial stance. A review is an adapter with an open lens
 * (the RFC's one-mechanism position): the reviewer hunts for what is WRONG
 * instead of confirming intent, and is told the author's reasoning is withheld
 * on purpose so it can not lean on a rationale it can not see. Caller `lenses`
 * APPEND to this stance; a caller `stance` replaces it wholesale.
 */
export const OPEN_ADVERSARIAL_REVIEW_STANCE =
  "You are an independent reviewer. Your job is to find what is WRONG with this change, " +
  "not to confirm what is right. The author's reasoning and intent are withheld from you " +
  "on purpose: do not assume a rationale you can not see, and do not give the change the " +
  "benefit of the doubt. Read the target files yourself. Report every issue you find as a " +
  "finding with a severity (critical, high, medium, or low), a category (correctness, " +
  "security, performance, concurrency, compatibility, operability, style, test_coverage, " +
  "or documentation), and concrete anchors (file paths, symbols, or line references). If " +
  "you genuinely find nothing wrong, say so with disposition=clear instead of inventing " +
  "findings; if you can not review safely because evidence is missing, say " +
  "disposition=inconclusive and list what is missing.";

/** Same literal pair subagent_run declares; resolveWaitMode is the one shared resolver. */
const REVIEW_WAIT_MODE_VALUES = ["completion", "start"] as const;

const ReviewWaitModeSchema = buildStringEnumSchema(REVIEW_WAIT_MODE_VALUES, {
  guidance:
    "Use completion to wait for the review and its receipts in this turn, or start to " +
    "dispatch the reviewer in the background and keep working — receipts commit when the " +
    "run completes; inspect it with subagent_status.",
});

const FilesTargetSchema = Type.Object(
  {
    kind: Type.Literal("files"),
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
      minItems: 1,
      maxItems: 64,
    }),
  },
  { additionalProperties: false },
);

const SessionDiffTargetSchema = Type.Object(
  { kind: Type.Literal("session_diff") },
  { additionalProperties: false },
);

const AtomsTargetSchema = Type.Object(
  {
    kind: Type.Literal("atoms"),
    atomIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 128,
      }),
    ),
  },
  { additionalProperties: false },
);

export const ReviewRequestParamsSchema = Type.Object({
  target: Type.Union([FilesTargetSchema, SessionDiffTargetSchema, AtomsTargetSchema], {
    description:
      "What to review: an explicit file set, session_diff (every file touched by the " +
      "session's applied patch sets), or atoms (the session's requirement atoms — all, or " +
      "the listed atomIds — checked for realization against the session's touched files).",
  }),
  lenses: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
      maxItems: 16,
      description:
        "Preloaded lens texts appended to the adversarial stance. Each is a specific angle " +
        "the reviewer must additionally hunt along (free text in this wave).",
    }),
  ),
  stance: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "Overrides the default open adversarial stance wholesale.",
    }),
  ),
  modelHint: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Advisory model-routing hint; gateway routing stays the decider.",
    }),
  ),
  waitMode: Type.Optional(ReviewWaitModeSchema),
});

/** The routed model the reviewer actually ran on, read from the delegation run record (never guessed). */
async function readRoutedModel(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  runId: string,
): Promise<string | null> {
  const delegation = runtime.delegation;
  if (!delegation?.listRuns) {
    return null;
  }
  const runs = await delegation.listRuns(sessionId, { runIds: [runId] });
  const record = runs.find((run) => run.runId === runId);
  return resolveRoutedModel(record?.modelRoute);
}

/**
 * The W1 discovery organ: dispatch ONE bounded fresh-context reviewer over a
 * diff/file/atoms target with an open or preloaded lens, wait for completion,
 * commit a finding receipt per parsed finding plus exactly one independent
 * verification outcome, and return a deterministic summary. Axiom 18: this tool
 * never blocks — findings are descriptive; it errors only for unusable inputs
 * (a bad target, or an atoms target with nothing to review), never for a
 * review verdict.
 */
export function createReviewRequestTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "review_request",
  );
  return define(
    {
      name: "review_request",
      label: "Review Request",
      description:
        "Dispatch one bounded fresh-context reviewer over a diff, file set, or the session's " +
        "requirement atoms with an open adversarial stance (or preloaded lenses), commit its " +
        "findings and one independent verification outcome as receipts, and return a summary. " +
        "The reviewer hunts for what is wrong; the author's context is withheld from it on " +
        "purpose. Findings are descriptive — this never blocks anything.",
      promptSnippet:
        "Use review_request to get an independent, adversarial second opinion on a change and " +
        "clear review debt with a fresh-context outcome receipt.",
      promptGuidelines: [
        "Target session_diff to review everything the session's applied patch sets touched, files for an explicit set, or atoms to check the session's requirement atoms are actually realized.",
        "Add lenses to steer the reviewer along specific angles (they append to the adversarial stance, never replace it).",
        "Override stance only to fully replace the default open-adversarial framing.",
        "A clean review still records an independent outcome — that is what clears review debt for fresh code.",
        "Use waitMode=start to keep working while the review runs; receipts commit on completion and findings anchor to the snapshot taken at dispatch.",
      ],
      parameters: Type.Object({
        ...ReviewRequestParamsSchema.properties,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const adapter = runtime.orchestration?.subagents;
        if (!adapter) {
          return errTextResult("review_request: subagent orchestration is unavailable.", {
            ok: false,
            error: "review_request_orchestration_unavailable",
          });
        }

        const reviewParams = readReviewParams(params);
        const sessionId = getSessionId(ctx);
        const workspaceRoot = resolveWorkspaceRoot(runtime, ctx);

        // An atoms target resolves against the tape BEFORE the snapshot: with
        // nothing to review (no atoms recorded, or atomIds naming none that
        // exist), the tool fails closed with an actionable error and never
        // dispatches — mirroring the empty-files/empty-session_diff checks.
        const atomsTargetAtoms =
          reviewParams.target.kind === "atoms"
            ? resolveAtomsForTarget(runtime, sessionId, reviewParams.target)
            : [];
        if (reviewParams.target.kind === "atoms" && atomsTargetAtoms.length === 0) {
          return errTextResult(
            "review_request: atoms target has no requirement atoms to review. Record " +
              "requirement atoms first, or pass a different target.",
            { ok: false, error: "review_request_no_atoms" },
          );
        }

        // Snapshot FIRST: the receipts must describe the tree state as it was
        // before the reviewer ran, even if patches land mid-review.
        const snapshot = snapshotTargetRef(runtime, sessionId, workspaceRoot, reviewParams.target);
        if (!snapshot.ok) {
          return errTextResult(snapshot.message, {
            ok: false,
            error: "review_request_invalid_target",
          });
        }
        const { targetRef } = snapshot;

        // The atoms this review ATTESTS: an explicit atoms target's set, or — for a
        // files/session_diff review that provably COVERS the whole fresh-touched
        // universe — the outstanding independence-debt atoms folded in (the
        // review→atom attribution close-edge). A narrow review folds nothing and
        // stays a pure code review. Resolved AFTER the snapshot: coverage is judged
        // against the exact targetRef the reviewer will read.
        const attestedAtoms =
          reviewParams.target.kind === "atoms"
            ? atomsTargetAtoms
            : resolveFoldedDebtAtoms(runtime, sessionId, workspaceRoot, targetRef);

        const lenses = reviewParams.lenses;

        // The dispatch anchor rides the request onto the run record in BOTH
        // modes: the record carries what receipts cannot re-derive later (the
        // pre-dispatch snapshot, lenses, stance honesty), and the tape-derived
        // idempotency guard in the shared commit path keeps receipts
        // exactly-once no matter which committer reaches the tape first.
        const reviewDispatch: DelegationReviewDispatch = {
          targetRef,
          lenses,
          stanceOverridden: reviewParams.stanceOverridden,
          // Every attested atom's id rides onto the run record (for BOTH the
          // in-tool and observer commit paths): it feeds a clear outcome's atomRefs
          // and lets a FAIL finding name the atom it violates. Populated for an
          // atoms target AND for a covering files/session_diff review with folded
          // debt; empty for a narrow review that attests no specific atom.
          reviewedAtomIds: attestedAtoms.map((atom) => atom.id),
        };
        const request: SubagentRunRequest = {
          agent: "explorer",
          consultKind: "review",
          mode: "single",
          packet: buildReviewPacket(reviewParams, targetRef, lenses, attestedAtoms),
          reviewDispatch,
        };

        if (reviewParams.waitMode === "start") {
          // Parallel review: return immediately; the author keeps working while
          // the reviewer runs. Receipts commit when the run reaches a terminal
          // status (the gateway's finalization observer), anchored to the
          // snapshot taken above — never to the tree as it looks at completion.
          const start = adapter.start?.bind(adapter);
          if (!start) {
            return errTextResult(
              "review_request: background start is unavailable on this runtime.",
              { ok: false, error: "review_request_start_unavailable" },
            );
          }
          const started = await start({ fromSessionId: sessionId, request });
          if (!started.ok) {
            return errTextResult(`review_request: reviewer dispatch failed: ${started.error}`, {
              ok: false,
              error: "review_request_dispatch_failed",
            });
          }
          const startedRunId = started.runs[0]?.runId;
          if (!startedRunId) {
            return errTextResult("review_request: reviewer start returned no run.", {
              ok: false,
              error: "review_request_no_run",
            });
          }
          return okTextResult(
            `independent review dispatched: run ${startedRunId} on ${targetRef.kind} snapshot; ` +
              "receipts will commit when the reviewer completes (inspect with subagent_status).",
            {
              ok: true,
              run_id: startedRunId,
              wait_mode: "start",
              target_ref_kind: targetRef.kind,
            },
          );
        }

        const result = await adapter.run({ fromSessionId: sessionId, request });
        if (!result.ok) {
          // Same terminal mapping as the observer path: a run that failed
          // before delivering a verdict leaves an honest independent `skipped`
          // receipt with the failure reason (axiom 7) when a run identity
          // exists. A launch that never created a run leaves nothing to anchor
          // a receipt to, so it stays a plain error.
          const failedRun = result.outcomes[0];
          if (failedRun) {
            commitReviewReceipts({
              runtime,
              sessionId,
              runId: failedRun.runId,
              routedModel: await readRoutedModel(runtime, sessionId, failedRun.runId),
              dispatch: reviewDispatch,
              source: { kind: "run_terminal_failure", reason: result.error },
            });
          }
          return errTextResult(`review_request: reviewer dispatch failed: ${result.error}`, {
            ok: false,
            error: "review_request_dispatch_failed",
          });
        }
        const reviewerOutcome = result.outcomes[0];
        if (!reviewerOutcome) {
          return errTextResult("review_request: reviewer returned no outcome.", {
            ok: false,
            error: "review_request_no_outcome",
          });
        }

        const routedModel = await readRoutedModel(runtime, sessionId, reviewerOutcome.runId);
        // ONE shared commit path (same function the finalization observer
        // runs): ok gate, disposition mapping, outcome-first ordering, and the
        // tape-derived exactly-once guard all live there — the two modes can
        // not drift.
        const receipts = commitReviewReceipts({
          runtime,
          sessionId,
          runId: reviewerOutcome.runId,
          routedModel,
          dispatch: reviewDispatch,
          source: {
            kind: "reviewer_outcome",
            ok: reviewerOutcome.ok,
            data: reviewerOutcome.data,
          },
        });
        if (!receipts.committed) {
          // Finding P3: distinguish "the findings could not be recorded" (the
          // capability was absent, so committing the outcome would have dropped
          // real reviewer counter-evidence) from the outcome seam being
          // unavailable — both leave the tape untouched, but the operator needs
          // to know WHICH seam failed.
          return receipts.reason === "findings_unavailable"
            ? errTextResult(
                "review_request: review findings could not be recorded (findings capability " +
                  "unavailable); no independent outcome was committed to avoid dropping findings.",
                { ok: false, error: "review_request_findings_unavailable" },
              )
            : errTextResult("review_request: verification recording is unavailable.", {
                ok: false,
                error: "review_request_record_unavailable",
              });
        }

        const resultText = buildReviewResultText({
          outcome: receipts.outcome,
          disposition: receipts.disposition,
          findings: receipts.findings,
          targetRef,
        });
        return okTextResult(resultText, {
          ok: true,
          outcome: receipts.outcome,
          disposition: receipts.disposition,
          // The TRUE recorded-finding count (Finding P3), not findings.length.
          findings_recorded: receipts.recordedFindingCount,
          target_ref_kind: targetRef.kind,
        });
      },
    },
    {},
  );
}

function readReviewParams(params: Record<string, unknown>): ReviewParams {
  const target = readTarget(params.target);
  const lenses = readStringArray(params.lenses);
  const stanceOverridden = typeof params.stance === "string" && params.stance.trim().length > 0;
  const stance = stanceOverridden ? (params.stance as string) : OPEN_ADVERSARIAL_REVIEW_STANCE;
  const modelHint =
    typeof params.modelHint === "string" && params.modelHint.trim().length > 0
      ? params.modelHint
      : undefined;
  return {
    target,
    lenses,
    stance,
    stanceOverridden,
    modelHint,
    waitMode: resolveWaitMode(params.waitMode),
  };
}

function readTarget(value: unknown): ReviewTarget {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.kind === "session_diff") {
      return { kind: "session_diff" };
    }
    if (record.kind === "atoms") {
      const atomIds = readStringArray(record.atomIds);
      return atomIds.length > 0 ? { kind: "atoms", atomIds } : { kind: "atoms" };
    }
    if (record.kind === "files") {
      return { kind: "files", paths: readStringArray(record.paths) };
    }
  }
  // Schema validation upstream guarantees a valid target; this pathless files
  // value is the honest fallback for an unparsable input. It is not a usable
  // snapshot: `snapshotTargetRef` rejects a zero-path files target with an
  // actionable error rather than digesting nothing, so a malformed target fails
  // closed instead of clearing review debt against an empty ref.
  return { kind: "files", paths: [] };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}
