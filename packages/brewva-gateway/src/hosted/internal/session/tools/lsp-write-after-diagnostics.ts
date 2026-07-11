import { relative } from "node:path";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaToolResult } from "@brewva/brewva-substrate/tools";
import {
  runLspWriteAfterDiagnostics,
  type LspWriteAfterDiagnostic,
} from "@brewva/brewva-tools/navigation";
import type { HostedToolResultTransform } from "../../turn/runtime-turn-tool-executor.js";

/** The minimal runtime surface the transform reads: the opt-in flag and the workspace cwd. */
interface LspWriteAfterRuntime {
  readonly config: { readonly lsp: { readonly diagnosticsOnApply: boolean } };
  readonly identity: { readonly cwd: string };
}

// Write-after diagnostics: after a successful `source_patch_apply`, run the
// language server over the files it just wrote and append an [LspDiagnostics]
// block to the SAME tool result, so a type error introduced by an edit surfaces
// immediately instead of on the next explicit `lsp_diagnostics` call. Borrowed
// from omp's "LSP wired into every write", adapted to brewva as a synchronous
// post-result transform in the hosted tool executor: the diagnostics become part
// of the canonical tool result BEFORE it is committed, so the tape, replay, and
// what the model sees are identical (no out-of-band next-turn injection, which
// would not survive replay). Opt-in via `lsp.diagnosticsOnApply`.
//
// Cost is bounded: the diagnostics fetch races a hard budget, so a cold server
// (first apply after idle) never blocks the turn — it simply yields no block that
// time and warms the pool for next time.

/** Max ms the apply result blocks waiting for diagnostics (cold server → no block). */
const INLINE_BUDGET_MS = 400;
/** Max diagnostic messages rendered in a single block. */
const MAX_MESSAGES = 20;

const BUDGET_EXCEEDED = Symbol("lsp-write-after-budget-exceeded");

function displayPath(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  return rel && !rel.startsWith("..") ? rel : absPath;
}

function severityCounts(diagnostics: readonly LspWriteAfterDiagnostic[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors += 1;
    } else if (diagnostic.severity === "warning") {
      warnings += 1;
    }
  }
  return { errors, warnings };
}

/** Inline block appended to the `source_patch_apply` tool result content. */
export function formatDiagnosticsBlock(
  diagnostics: readonly LspWriteAfterDiagnostic[],
  cwd: string,
  maxMessages: number = MAX_MESSAGES,
): string {
  const { errors, warnings } = severityCounts(diagnostics);
  const shown = diagnostics.slice(0, Math.max(1, maxMessages));
  const lines = shown.map((diagnostic) => {
    const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
    return `- ${diagnostic.severity} ${displayPath(diagnostic.path, cwd)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}${code}`;
  });
  if (diagnostics.length > shown.length) {
    lines.push(`- … ${diagnostics.length - shown.length} more`);
  }
  return [
    "",
    `[LspDiagnostics] errors=${errors} warnings=${warnings} — from files you just edited`,
    ...lines,
  ].join("\n");
}

interface LspWriteAfterDeps {
  readonly runDiagnostics?: typeof runLspWriteAfterDiagnostics;
  /** Budget override (ms). Test seam; production uses {@link INLINE_BUDGET_MS}. */
  readonly budgetMs?: number;
}

/**
 * Build the hosted-tool-result transform for write-after diagnostics, or
 * `undefined` when the feature is off (opt-in). The transform runs in the hosted
 * tool executor; a non-`source_patch_apply` or non-applied result passes through
 * untouched. Best-effort: any failure returns the original result — diagnostics
 * never break a successful apply.
 */
export function createLspWriteAfterTransform(
  runtime: LspWriteAfterRuntime,
  deps: LspWriteAfterDeps = {},
): HostedToolResultTransform | undefined {
  if (!runtime.config.lsp.diagnosticsOnApply) {
    return undefined;
  }
  const cwd = runtime.identity.cwd;
  const runDiagnostics = deps.runDiagnostics ?? runLspWriteAfterDiagnostics;
  const budgetMs = deps.budgetMs ?? INLINE_BUDGET_MS;

  return async ({ toolName, result, signal }): Promise<BrewvaToolResult> => {
    if (toolName !== "source_patch_apply" || result.outcome.kind !== "ok") {
      return result;
    }
    const value = result.outcome.value;
    if (!isRecord(value) || value.status !== "applied") {
      return result;
    }
    const appliedPaths = Array.isArray(value.appliedPaths)
      ? value.appliedPaths.filter((path): path is string => typeof path === "string")
      : [];
    if (appliedPaths.length === 0) {
      return result;
    }

    const fetchPromise = runDiagnostics({
      cwd,
      absPaths: appliedPaths,
      timeoutMs: budgetMs,
      signal,
    });
    // Race the whole fetch (server spawn included) against the budget so a cold
    // server never blocks the turn. An abandoned fetch just warms the pool.
    fetchPromise.catch(() => undefined);
    const timeout = new Promise<typeof BUDGET_EXCEEDED>((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout(BUDGET_EXCEEDED), budgetMs);
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as { unref(): void }).unref();
      }
    });

    let outcome: Awaited<ReturnType<typeof runDiagnostics>> | typeof BUDGET_EXCEEDED;
    try {
      outcome = await Promise.race([fetchPromise, timeout]);
    } catch {
      return result;
    }
    if (outcome === BUDGET_EXCEEDED || !outcome.available || outcome.diagnostics.length === 0) {
      return result;
    }
    return {
      ...result,
      content: [
        ...result.content,
        { type: "text" as const, text: formatDiagnosticsBlock(outcome.diagnostics, cwd) },
      ],
    };
  };
}
