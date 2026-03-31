import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { auditPrecedentRecord, type PrecedentAuditSummary } from "./precedent-audit.js";
import {
  deriveSolutionId,
  deriveSolutionRelativePath,
  formatIsoDate,
  normalizeDocumentText,
  normalizeRelativePath,
  normalizeSolutionRecord,
  parseSolutionDocument,
  renderSolutionDocument,
  SolutionRecordInputSchema,
  validateSolutionRecord,
} from "./solution-record.js";
import { isPathInsideRoots, resolveScopedPath, resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

interface ResolvedSolutionPath {
  absolutePath: string;
  relativePath: string;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveSolutionPath(input: {
  scope: ReturnType<typeof resolveToolTargetScope>;
  requestedPath?: string;
  record: ReturnType<typeof normalizeSolutionRecord>;
}): ResolvedSolutionPath | { error: string } {
  if (input.requestedPath) {
    const absolutePath = resolveScopedPath(input.requestedPath, input.scope);
    if (!absolutePath) {
      return { error: "knowledge_capture path escapes the current task target roots." };
    }
    if (!isPathInsideRoots(absolutePath, [input.scope.primaryRoot])) {
      return { error: "knowledge_capture path must stay inside the primary target root." };
    }
    const relativePath = normalizeRelativePath(relative(input.scope.primaryRoot, absolutePath));
    if (!relativePath.startsWith("docs/solutions/")) {
      return { error: "knowledge_capture path must live under docs/solutions/." };
    }
    if (!relativePath.endsWith(".md")) {
      return { error: "knowledge_capture path must end with .md." };
    }
    return { absolutePath, relativePath };
  }

  const relativePath = deriveSolutionRelativePath(input.record);
  return {
    absolutePath: join(input.scope.primaryRoot, relativePath),
    relativePath,
  };
}

function inspectDiscoverability(primaryRoot: string): {
  status: "ok" | "partial";
  inspected: string[];
  missing: string[];
} {
  const inspected: string[] = [];
  const missing: string[] = [];
  for (const relativePath of ["AGENTS.md", "README.md"]) {
    const absolutePath = join(primaryRoot, relativePath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      continue;
    }
    inspected.push(relativePath);
    const text = readFileSync(absolutePath, "utf8");
    const hasKnowledgeHint =
      text.includes("docs/solutions") ||
      text.includes("knowledge_search") ||
      text.includes("knowledge-capture") ||
      text.includes("knowledge_capture") ||
      text.includes("precedent_audit");
    if (!hasKnowledgeHint) {
      missing.push(relativePath);
    }
  }
  return {
    status: missing.length === 0 ? "ok" : "partial",
    inspected,
    missing,
  };
}

function formatResultText(input: {
  captureStatus: "created" | "updated" | "skipped";
  solutionDocPath: string;
  solutionId: string;
  discoverability: ReturnType<typeof inspectDiscoverability>;
  precedentAudit: PrecedentAuditSummary;
}): string {
  const lines = [
    "# Knowledge Capture",
    `status: ${input.captureStatus}`,
    `path: ${input.solutionDocPath}`,
    `solution_id: ${input.solutionId}`,
    `discoverability: ${input.discoverability.status}`,
    `authority_audit: ${input.precedentAudit.verdict}`,
    `maintenance_recommendation: ${input.precedentAudit.maintenanceRecommendation}`,
    `derivative_link_status: ${input.precedentAudit.derivativeLinkStatus}`,
  ];
  if (input.discoverability.missing.length > 0) {
    lines.push(`discoverability_missing: ${input.discoverability.missing.join(", ")}`);
  }
  if (input.precedentAudit.stableDocRefs.length > 0) {
    lines.push(`stable_doc_refs: ${input.precedentAudit.stableDocRefs.join(", ")}`);
  }
  if (input.precedentAudit.peerSolutionRefs.length > 0) {
    lines.push(`peer_solution_refs: ${input.precedentAudit.peerSolutionRefs.join(", ")}`);
  }
  if (input.precedentAudit.findings.length > 0) {
    lines.push("authority_findings:");
    for (const finding of input.precedentAudit.findings) {
      const refs = finding.refs.length > 0 ? ` [${finding.refs.join(", ")}]` : "";
      lines.push(`- ${finding.severity} ${finding.code}: ${finding.summary}${refs}`);
    }
  }
  return lines.join("\n");
}

export function createKnowledgeCaptureTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "knowledge_capture",
    label: "Knowledge Capture",
    description:
      "Materialize or update canonical solution records under docs/solutions from structured terminal artifacts.",
    promptSnippet:
      "Use this after terminal work to write repository-native precedents back into docs/solutions without widening runtime authority.",
    promptGuidelines: [
      "Prefer updating an existing canonical solution record over creating a duplicate when the failure class is materially the same.",
      "Bugfix and incident captures require investigation-grade evidence and should preserve failed attempts explicitly.",
      "When a stable doc or successor precedent displaced an older record, make the stale or superseded routing explicit instead of leaving active ambiguity behind.",
    ],
    parameters: Type.Object({
      solution_record: SolutionRecordInputSchema,
      solution_doc_path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(options.runtime, ctx);
      const record = normalizeSolutionRecord(params.solution_record);
      const validationProblems = validateSolutionRecord(record);
      if (validationProblems.length > 0) {
        return failTextResult(validationProblems.join("\n"), {
          ok: false,
          error: "invalid_solution_record",
          validationProblems,
        });
      }

      const requestedPath = readTrimmedString(params.solution_doc_path);
      const pathResolution = resolveSolutionPath({
        scope,
        requestedPath,
        record,
      });
      if ("error" in pathResolution) {
        return failTextResult(pathResolution.error, {
          ok: false,
          error: "invalid_solution_doc_path",
          requestedPath: requestedPath ?? null,
        });
      }

      const precedentAudit = auditPrecedentRecord({
        scope,
        record,
        candidatePath: pathResolution.relativePath,
      });
      if (precedentAudit.verdict === "fail") {
        return failTextResult(
          formatResultText({
            captureStatus: "skipped",
            solutionDocPath: pathResolution.relativePath,
            solutionId: record.id ?? "pending",
            discoverability: inspectDiscoverability(scope.primaryRoot),
            precedentAudit,
          }),
          {
            ok: false,
            error: "precedent_audit_failed",
            solutionDocPath: pathResolution.relativePath,
            precedentAudit,
          },
        );
      }

      const discoverability = inspectDiscoverability(scope.primaryRoot);
      let existingText: string | null = null;
      if (existsSync(pathResolution.absolutePath)) {
        if (!statSync(pathResolution.absolutePath).isFile()) {
          return failTextResult("knowledge_capture target path is not a file.", {
            ok: false,
            error: "target_not_file",
            solutionDocPath: pathResolution.relativePath,
          });
        }
        existingText = readFileSync(pathResolution.absolutePath, "utf8");
      }
      const existingParsed = existingText ? parseSolutionDocument(existingText) : null;
      const existingId = existingParsed?.id ?? null;
      if (record.id && existingId && record.id !== existingId) {
        return failTextResult(
          `knowledge_capture refuses to overwrite ${pathResolution.relativePath} because the existing id (${existingId}) conflicts with solution_record.id (${record.id}).`,
          {
            ok: false,
            error: "solution_id_conflict",
            solutionDocPath: pathResolution.relativePath,
            existingId,
            requestedId: record.id,
          },
        );
      }

      const today = formatIsoDate();
      const effectiveId =
        record.id ?? existingId ?? deriveSolutionId(record, record.updatedAt ?? today);
      const currentUpdatedAt = record.updatedAt ?? today;
      const nextDocument = renderSolutionDocument(record, {
        id: effectiveId,
        updatedAt: currentUpdatedAt,
      });
      const normalizedExisting = existingText ? normalizeDocumentText(existingText) : null;
      const normalizedNext = normalizeDocumentText(nextDocument);

      if (normalizedExisting === normalizedNext) {
        return textResult(
          formatResultText({
            captureStatus: "skipped",
            solutionDocPath: pathResolution.relativePath,
            solutionId: effectiveId,
            discoverability,
            precedentAudit,
          }),
          {
            ok: true,
            captureStatus: "skipped",
            solutionDocPath: pathResolution.relativePath,
            solutionId: effectiveId,
            discoverability,
            precedentAudit,
            solutionRecord: record,
          },
        );
      }

      if (!record.updatedAt && normalizedExisting) {
        const existingUpdatedAt = existingParsed?.updatedAt;
        if (existingUpdatedAt) {
          const stableDocument = normalizeDocumentText(
            renderSolutionDocument(record, {
              id: effectiveId,
              updatedAt: existingUpdatedAt,
            }),
          );
          if (stableDocument === normalizedExisting) {
            return textResult(
              formatResultText({
                captureStatus: "skipped",
                solutionDocPath: pathResolution.relativePath,
                solutionId: effectiveId,
                discoverability,
                precedentAudit,
              }),
              {
                ok: true,
                captureStatus: "skipped",
                solutionDocPath: pathResolution.relativePath,
                solutionId: effectiveId,
                discoverability,
                precedentAudit,
                solutionRecord: {
                  ...record,
                  updatedAt: existingUpdatedAt,
                },
              },
            );
          }
        }
      }

      const finalUpdatedAt = record.updatedAt ?? today;
      const finalDocument = renderSolutionDocument(record, {
        id: effectiveId,
        updatedAt: finalUpdatedAt,
      });

      mkdirSync(dirname(pathResolution.absolutePath), { recursive: true });
      writeFileSync(pathResolution.absolutePath, finalDocument, "utf8");

      const captureStatus = existingText ? "updated" : "created";
      return textResult(
        formatResultText({
          captureStatus,
          solutionDocPath: pathResolution.relativePath,
          solutionId: effectiveId,
          discoverability,
          precedentAudit,
        }),
        {
          ok: true,
          captureStatus,
          solutionDocPath: pathResolution.relativePath,
          solutionId: effectiveId,
          discoverability,
          precedentAudit,
          solutionRecord: {
            ...record,
            id: effectiveId,
            updatedAt: finalUpdatedAt,
          },
        },
      );
    },
  });
}
