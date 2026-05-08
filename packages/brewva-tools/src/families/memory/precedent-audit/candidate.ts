import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import {
  isPathInsideRoots,
  resolveScopedPath,
  resolveToolTargetScope,
} from "../../../runtime-port/target-scope.js";
import {
  normalizeRelativePath,
  normalizeSolutionRecord,
  parseSolutionDocument,
  validateSolutionRecord,
} from "../solution-record.js";
import { SOLUTION_DOC_PREFIX, readTrimmedString } from "./support.js";
import type { LoadedAuditCandidate } from "./types.js";

export function loadAuditCandidate(input: {
  scope: ReturnType<typeof resolveToolTargetScope>;
  requestedPath?: string;
  rawRecord?: unknown;
}):
  | {
      ok: true;
      candidate: LoadedAuditCandidate;
    }
  | {
      ok: false;
      message: string;
      details: Record<string, unknown>;
    } {
  const requestedPath = readTrimmedString(input.requestedPath);
  const hasRecord = Boolean(input.rawRecord && typeof input.rawRecord === "object");

  if (!requestedPath && !hasRecord) {
    return {
      ok: false,
      message: "precedent_audit requires solution_doc_path, solution_record, or both.",
      details: {
        error: "missing_audit_target",
      },
    };
  }

  if (requestedPath && !hasRecord) {
    const absolutePath = resolveScopedPath(requestedPath, input.scope);
    if (!absolutePath || !isPathInsideRoots(absolutePath, [input.scope.primaryRoot])) {
      return {
        ok: false,
        message: "precedent_audit path must stay inside the primary target root.",
        details: {
          error: "invalid_solution_doc_path",
          requestedPath,
        },
      };
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      return {
        ok: false,
        message: "precedent_audit target solution document does not exist.",
        details: {
          error: "missing_solution_doc",
          requestedPath,
        },
      };
    }
    const relativePath = normalizeRelativePath(relative(input.scope.primaryRoot, absolutePath));
    if (!relativePath.startsWith(SOLUTION_DOC_PREFIX) || !relativePath.endsWith(".md")) {
      return {
        ok: false,
        message: "precedent_audit only accepts solution documents under docs/solutions/.",
        details: {
          error: "invalid_solution_doc_path",
          requestedPath: relativePath,
        },
      };
    }
    const parsed = parseSolutionDocument(readFileSync(absolutePath, "utf8"));
    const problems = validateSolutionRecord(parsed.record);
    if (problems.length > 0) {
      return {
        ok: false,
        message: problems.join("\n"),
        details: {
          error: "invalid_solution_record",
          validationProblems: problems,
          solutionDocPath: relativePath,
        },
      };
    }
    return {
      ok: true,
      candidate: {
        record: parsed.record,
        candidatePath: relativePath,
      },
    };
  }

  const record = normalizeSolutionRecord(
    input.rawRecord as Parameters<typeof normalizeSolutionRecord>[0],
  );
  const problems = validateSolutionRecord(record);
  if (problems.length > 0) {
    return {
      ok: false,
      message: problems.join("\n"),
      details: {
        error: "invalid_solution_record",
        validationProblems: problems,
      },
    };
  }

  return {
    ok: true,
    candidate: {
      record,
      ...(requestedPath ? { candidatePath: normalizeRelativePath(requestedPath) } : {}),
    },
  };
}
