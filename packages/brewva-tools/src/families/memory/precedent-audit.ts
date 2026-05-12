import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";
import { auditPrecedentRecord } from "./precedent-audit/audit.js";
import { loadAuditCandidate } from "./precedent-audit/candidate.js";
import { formatAuditText } from "./precedent-audit/render.js";
import { SolutionRecordInputSchema } from "./solution-record.js";

export { auditPrecedentRecord } from "./precedent-audit/audit.js";
export type {
  DerivativeLinkAuditStatus,
  PrecedentAuditFinding,
  PrecedentAuditFindingSeverity,
  PrecedentAuditSummary,
  PrecedentAuditVerdict,
  PrecedentMaintenanceRecommendation,
} from "./precedent-audit/types.js";

export function createPrecedentAuditTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "precedent_audit",
  );
  return define({
    name: "precedent_audit",
    label: "Precedent Audit",
    description:
      "Inspect a candidate or existing solution precedent against higher-authority docs and sibling precedents to surface stale routing or contradiction maintenance work.",
    promptSnippet:
      "Use this when refreshing, displacing, or validating docs/solutions records so authority conflicts and stale routing stay explicit.",
    promptGuidelines: [
      "Prefer this before marking a record stale or superseded, or when a stable doc may have displaced an older precedent.",
      "Treat audit findings as repository-maintenance guidance, not runtime claim or hidden planner state.",
    ],
    parameters: Type.Object({
      solution_doc_path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      solution_record: Type.Optional(SolutionRecordInputSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(runtime, ctx);
      const loaded = loadAuditCandidate({
        scope,
        requestedPath: params.solution_doc_path,
        rawRecord: params.solution_record,
      });
      if (!loaded.ok) {
        return failTextResult(loaded.message, {
          ok: false,
          ...loaded.details,
        });
      }

      const audit = auditPrecedentRecord({
        scope,
        record: loaded.candidate.record,
        candidatePath: loaded.candidate.candidatePath,
        limit: params.limit,
      });

      const details = {
        ok: audit.verdict !== "fail",
        ...audit,
      };
      if (audit.verdict === "fail") {
        return failTextResult(formatAuditText(audit), details);
      }
      if (audit.verdict === "inconclusive") {
        return inconclusiveTextResult(formatAuditText(audit), details);
      }
      return textResult(formatAuditText(audit), details);
    },
  });
}
