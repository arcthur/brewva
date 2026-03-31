import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  auditPrecedentRecord,
  type PrecedentAuditFinding,
  type PrecedentAuditSummary,
  type PrecedentMaintenanceRecommendation,
} from "./precedent-audit.js";
import {
  parseSolutionDocument,
  type SolutionStatus,
  validateSolutionRecord,
} from "./solution-record.js";
import { resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SOLUTION_STATUS_VALUES = ["active", "stale", "superseded"] as const;
const MAINTENANCE_RECOMMENDATION_VALUES = [
  "none",
  "review_for_drift",
  "mark_stale",
  "mark_superseded",
  "complete_derivative_routing",
] as const;

const SolutionStatusSchema = buildStringEnumSchema(SOLUTION_STATUS_VALUES, {});
const MaintenanceRecommendationSchema = buildStringEnumSchema(
  MAINTENANCE_RECOMMENDATION_VALUES,
  {},
);

interface SweepEntry {
  path: string;
  title: string;
  status: SolutionStatus | "unknown";
  problemKind: string;
  module?: string;
  verdict: "pass" | "inconclusive" | "fail";
  maintenanceRecommendation: PrecedentMaintenanceRecommendation;
  derivativeLinkStatus: PrecedentAuditSummary["derivativeLinkStatus"];
  findings: PrecedentAuditFinding[];
  validationProblems: string[];
  stableDocRefs: string[];
  peerSolutionRefs: string[];
}

function collectSolutionFiles(rootDir: string): string[] {
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (
        entry.isFile() &&
        /\.(md|mdx)$/i.test(entry.name) &&
        !/^readme\.mdx?$/i.test(entry.name)
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files.toSorted();
}

function inferInvalidMaintenanceRecommendation(
  validationProblems: readonly string[],
): PrecedentMaintenanceRecommendation {
  if (validationProblems.some((problem) => /derivative link|superseded|stale/i.test(problem))) {
    return "complete_derivative_routing";
  }
  return "review_for_drift";
}

function inferInvalidDerivativeStatus(
  status: SweepEntry["status"],
  validationProblems: readonly string[],
): SweepEntry["derivativeLinkStatus"] {
  if (status === "active" || status === "unknown") {
    return "not_applicable";
  }
  if (validationProblems.some((problem) => /derivative link/i.test(problem))) {
    return "insufficient";
  }
  return "unresolved";
}

function toValidationFindings(
  path: string,
  validationProblems: readonly string[],
): PrecedentAuditFinding[] {
  return validationProblems.map((problem) => ({
    code: "invalid_solution_record",
    severity: "error" as const,
    summary: problem,
    refs: [path],
  }));
}

function summarizeOverallVerdict(entries: readonly SweepEntry[]): "pass" | "inconclusive" | "fail" {
  if (entries.some((entry) => entry.verdict === "fail")) {
    return "fail";
  }
  if (entries.some((entry) => entry.verdict === "inconclusive")) {
    return "inconclusive";
  }
  return "pass";
}

function formatSweepText(input: {
  verdict: "pass" | "inconclusive" | "fail";
  totalDocs: number;
  auditedDocs: number;
  emittedDocs: number;
  actionableDocs: number;
  truncated: boolean;
  entries: readonly SweepEntry[];
}): string {
  const lines = [
    "# Precedent Sweep",
    `verdict: ${input.verdict}`,
    `total_docs: ${input.totalDocs}`,
    `audited_docs: ${input.auditedDocs}`,
    `actionable_docs: ${input.actionableDocs}`,
    `emitted_docs: ${input.emittedDocs}`,
    `truncated: ${input.truncated ? "yes" : "no"}`,
  ];
  if (input.entries.length === 0) {
    lines.push("results: none");
    return lines.join("\n");
  }
  lines.push("results:");
  for (const entry of input.entries) {
    lines.push(
      `- ${entry.verdict} | ${entry.maintenanceRecommendation} | ${entry.path} | status=${entry.status} | derivative=${entry.derivativeLinkStatus}`,
    );
    if (entry.validationProblems.length > 0) {
      lines.push(`  validation: ${entry.validationProblems.join(" ; ")}`);
    }
    if (entry.stableDocRefs.length > 0) {
      lines.push(`  stable_doc_refs: ${entry.stableDocRefs.join(", ")}`);
    }
    if (entry.peerSolutionRefs.length > 0) {
      lines.push(`  peer_solution_refs: ${entry.peerSolutionRefs.join(", ")}`);
    }
    if (entry.findings.length > 0) {
      lines.push(
        `  findings: ${entry.findings.map((finding) => `${finding.code}:${finding.severity}`).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

export function createPrecedentSweepTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "precedent_sweep",
    label: "Precedent Sweep",
    description:
      "Run an explicit repository-wide stale-document maintenance sweep across docs/solutions without turning maintenance into a default path.",
    promptSnippet:
      "Use this when you want a broad repository precedent maintenance pass instead of a single-record audit.",
    promptGuidelines: [
      "This tool is explicit and read-only. It does not mutate solution docs or schedule hidden maintenance.",
      "Use precedent_audit for a single record; use precedent_sweep when you need repository-wide stale routing or drift visibility.",
    ],
    parameters: Type.Object({
      status: Type.Optional(SolutionStatusSchema),
      module: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      recommendation: Type.Optional(MaintenanceRecommendationSchema),
      include_clean: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      output_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(options.runtime, ctx);
      const solutionRoot = join(scope.primaryRoot, "docs", "solutions");
      const files = collectSolutionFiles(solutionRoot);
      if (files.length === 0) {
        return inconclusiveTextResult(
          ["# Precedent Sweep", "verdict: inconclusive", "total_docs: 0", "results: none"].join(
            "\n",
          ),
          {
            ok: false,
            verdict: "inconclusive",
            totalDocs: 0,
            auditedDocs: 0,
            actionableDocs: 0,
            entries: [],
          },
        );
      }

      const statusFilter = params.status;
      const moduleFilter = params.module?.trim();
      const recommendationFilter = params.recommendation;
      const includeClean = params.include_clean ?? false;
      const limit = Math.max(1, Math.min(500, params.limit ?? files.length));
      const outputLimit = Math.max(1, Math.min(200, params.output_limit ?? 50));

      const entries: SweepEntry[] = [];
      let auditedDocs = 0;
      for (const absolutePath of files) {
        if (auditedDocs >= limit) {
          break;
        }
        const relativePath = relative(scope.primaryRoot, absolutePath).replace(/\\/g, "/");
        const parsed = parseSolutionDocument(readFileSync(absolutePath, "utf8"));
        const record = parsed.record;

        if (statusFilter && record.status !== statusFilter) {
          continue;
        }
        if (moduleFilter && record.module?.toLowerCase() !== moduleFilter.toLowerCase()) {
          continue;
        }

        auditedDocs += 1;

        const validationProblems = validateSolutionRecord(record);
        let entry: SweepEntry;
        if (validationProblems.length > 0) {
          entry = {
            path: relativePath,
            title: record.title,
            status: record.status ?? "unknown",
            problemKind: record.problemKind,
            ...(record.module ? { module: record.module } : {}),
            verdict: "fail",
            maintenanceRecommendation: inferInvalidMaintenanceRecommendation(validationProblems),
            derivativeLinkStatus: inferInvalidDerivativeStatus(record.status, validationProblems),
            findings: toValidationFindings(relativePath, validationProblems),
            validationProblems,
            stableDocRefs: [],
            peerSolutionRefs: [],
          };
        } else {
          const audit = auditPrecedentRecord({
            scope,
            record,
            candidatePath: relativePath,
          });
          entry = {
            path: relativePath,
            title: record.title,
            status: record.status,
            problemKind: record.problemKind,
            ...(record.module ? { module: record.module } : {}),
            verdict: audit.verdict,
            maintenanceRecommendation: audit.maintenanceRecommendation,
            derivativeLinkStatus: audit.derivativeLinkStatus,
            findings: audit.findings,
            validationProblems: [],
            stableDocRefs: audit.stableDocRefs,
            peerSolutionRefs: audit.peerSolutionRefs,
          };
        }

        if (recommendationFilter && entry.maintenanceRecommendation !== recommendationFilter) {
          continue;
        }
        if (
          !includeClean &&
          entry.maintenanceRecommendation === "none" &&
          entry.verdict === "pass"
        ) {
          continue;
        }
        entries.push(entry);
      }

      const actionableDocs = entries.filter(
        (entry) => entry.maintenanceRecommendation !== "none" || entry.verdict !== "pass",
      ).length;
      const truncated = entries.length > outputLimit;
      const emittedEntries = truncated ? entries.slice(0, outputLimit) : entries;
      const verdict = summarizeOverallVerdict(entries);
      const details = {
        ok: verdict !== "fail",
        verdict,
        totalDocs: files.length,
        auditedDocs,
        actionableDocs,
        emittedDocs: emittedEntries.length,
        truncated,
        entries: emittedEntries.map((entry) => ({
          path: entry.path,
          title: entry.title,
          status: entry.status,
          problemKind: entry.problemKind,
          module: entry.module ?? null,
          verdict: entry.verdict,
          maintenanceRecommendation: entry.maintenanceRecommendation,
          derivativeLinkStatus: entry.derivativeLinkStatus,
          validationProblems: entry.validationProblems,
          stableDocRefs: entry.stableDocRefs,
          peerSolutionRefs: entry.peerSolutionRefs,
          findingCodes: entry.findings.map((finding) => finding.code),
        })),
      };

      const text = formatSweepText({
        verdict,
        totalDocs: files.length,
        auditedDocs,
        emittedDocs: emittedEntries.length,
        actionableDocs,
        truncated,
        entries: emittedEntries,
      });

      if (verdict === "fail") {
        return failTextResult(text, details);
      }
      if (verdict === "inconclusive") {
        return inconclusiveTextResult(text, details);
      }
      return textResult(text, details);
    },
  });
}
