import { readStringList } from "@brewva/brewva-std/text";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { VERIFICATION_RUNGS } from "@brewva/brewva-vocabulary/iteration";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { recordVerificationOutcome } from "../../runtime-port/verification.js";
import { readLiteral } from "../../utils/literal.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const OUTCOME_VALUES = ["pass", "fail", "skipped"] as const;

const OutcomeSchema = buildStringEnumSchema(OUTCOME_VALUES, {});
const RungSchema = buildStringEnumSchema(VERIFICATION_RUNGS, {});

/**
 * Model-facing producer for the `verification.outcome.recorded` receipt.
 *
 * The receipt is what Work Card Evidence, stall adjudication, and
 * `inspect run-report` read; an unrecorded verification is invisible to every
 * one of them. Recording evidence grants no authority — the tool commits what
 * was checked and what rung of the verification ladder the checks reached.
 */
export function createVerificationRecordTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "verification_record",
  );
  return define(
    {
      name: "verification_record",
      label: "Verification Record",
      description:
        "Commit the verification outcome for the current session as the canonical receipt. " +
        "level names the verification-ladder rung the executed checks actually reached: " +
        "exit_code (command exited 0) < diagnostics (zero or disclosed warnings) < artifact " +
        "(produced artifact structurally validated) < requirements (each requirement " +
        "re-derived from code) < runtime_smoke (behavior probed at runtime).",
      parameters: Type.Object({
        outcome: OutcomeSchema,
        level: RungSchema,
        checks: Type.Optional(Type.Array(Type.String())),
        failedChecks: Type.Optional(Type.Array(Type.String())),
        missingChecks: Type.Optional(Type.Array(Type.String())),
        missingEvidence: Type.Optional(Type.Array(Type.String())),
        reason: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const outcome = readLiteral(params.outcome, OUTCOME_VALUES);
        const level = readLiteral(params.level, VERIFICATION_RUNGS);
        if (!outcome || !level) {
          return errTextResult("verification_record requires outcome and a valid ladder level.", {
            ok: false,
            error: "verification_record_invalid_input",
          });
        }
        const checks = readStringList(params.checks);
        const failedChecks = readStringList(params.failedChecks);
        if (outcome === "fail" && failedChecks.length === 0) {
          return errTextResult(
            "A fail outcome must name at least one failed check so the receipt stays actionable.",
            { ok: false, error: "verification_record_missing_failed_checks" },
          );
        }
        const result = await recordVerificationOutcome(runtime, sessionId, {
          outcome,
          level,
          checks,
          failedChecks,
          missingChecks: readStringList(params.missingChecks),
          missingEvidence: readStringList(params.missingEvidence),
          evidenceFreshness: "fresh",
          reason: typeof params.reason === "string" ? params.reason : null,
        });
        if (!result) {
          return errTextResult("Verification recording is unavailable in this runtime.", {
            ok: false,
            error: "verification_record_unavailable",
          });
        }
        return okTextResult(
          `Recorded verification outcome=${outcome} at rung=${level} (${checks.length} checks).`,
          {
            ok: true,
            outcome,
            level,
            checks_recorded: checks.length,
            failed_checks: failedChecks.length,
          },
        );
      },
    },
    {},
  );
}
