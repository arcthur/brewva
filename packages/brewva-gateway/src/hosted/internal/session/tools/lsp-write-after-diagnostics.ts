import { relative, resolve } from "node:path";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  getFileMutationVersion,
  runLspWriteAfterDiagnostics,
  type LspWriteAfterDiagnostic,
  type LspWriteAfterDiagnosticsResult,
} from "@brewva/brewva-tools/navigation";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";

// Write-after diagnostics: after a successful `source_patch_apply`, run the
// language server over the files it just wrote and surface type errors in the
// same tool result, so a bad edit is caught immediately instead of on the next
// explicit `lsp_diagnostics` call. Borrowed from omp's "LSP wired into every
// write" (runLspWritethrough), adapted to brewva's tool-result interceptor +
// in-memory next-turn injection substrate. Noise control, mirroring omp:
//  - inline budget: block the result only briefly; warm server wins, cold
//    server hands off to a next-turn advisory.
//  - staleness drop: a slow background result is discarded for any file a newer
//    apply superseded (per-file mutation version).
//  - cross-turn ledger: report only diagnostics not already reported this
//    session, so re-applying a file does not re-flood known errors.

/** kebab customType for the out-of-band next-turn diagnostics advisory. */
export const LSP_WRITE_AFTER_DIAGNOSTICS_MESSAGE_TYPE = "brewva-lsp-diagnostics";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function diagnosticIdentity(diagnostic: LspWriteAfterDiagnostic): string {
  // Line/column are excluded so an error that merely shifted lines is not
  // re-reported; severity + code + message identify the finding itself.
  return `${diagnostic.severity}\u0000${diagnostic.code ?? ""}\u0000${diagnostic.message}`;
}

/**
 * Session-scoped "only-new" filter, keyed per file. Reports a diagnostic once
 * per session; a re-apply of the same file re-flags nothing already seen. Reset
 * on compaction/session switch so a summarized-away error can legitimately
 * re-surface. Mirrors omp's `DiagnosticsLedger`.
 */
export class DiagnosticsLedger {
  readonly #seenByPath = new Map<string, Set<string>>();

  reduce(diagnostics: readonly LspWriteAfterDiagnostic[]): LspWriteAfterDiagnostic[] {
    const fresh: LspWriteAfterDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const key = resolve(diagnostic.path);
      let seen = this.#seenByPath.get(key);
      if (!seen) {
        seen = new Set<string>();
        this.#seenByPath.set(key, seen);
      }
      const identity = diagnosticIdentity(diagnostic);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      fresh.push(diagnostic);
    }
    return fresh;
  }

  reset(): void {
    this.#seenByPath.clear();
  }
}

/**
 * Drop diagnostics for any file whose mutation version advanced since the
 * versions were snapshotted at apply-dispatch time — a newer apply superseded
 * that file, so late diagnostics for the older content are stale.
 */
export function dropStaleDiagnostics(
  diagnostics: readonly LspWriteAfterDiagnostic[],
  appliedPaths: readonly string[],
  versionsAtDispatch: readonly number[],
): LspWriteAfterDiagnostic[] {
  const stale = new Set<string>();
  appliedPaths.forEach((path, index) => {
    if (getFileMutationVersion(path) !== versionsAtDispatch[index]) {
      stale.add(resolve(path));
    }
  });
  if (stale.size === 0) {
    return [...diagnostics];
  }
  return diagnostics.filter((diagnostic) => !stale.has(resolve(diagnostic.path)));
}

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

function renderDiagnosticLines(
  diagnostics: readonly LspWriteAfterDiagnostic[],
  cwd: string,
  maxMessages: number,
): string[] {
  const shown = diagnostics.slice(0, Math.max(1, maxMessages));
  const lines = shown.map((diagnostic) => {
    const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
    return `- ${diagnostic.severity} ${displayPath(diagnostic.path, cwd)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}${code}`;
  });
  if (diagnostics.length > shown.length) {
    lines.push(`- … ${diagnostics.length - shown.length} more`);
  }
  return lines;
}

/** Inline block appended to the `source_patch_apply` tool result content. */
export function formatDiagnosticsBlock(
  diagnostics: readonly LspWriteAfterDiagnostic[],
  cwd: string,
  maxMessages: number,
): string {
  const { errors, warnings } = severityCounts(diagnostics);
  return [
    "",
    `[LspDiagnostics] errors=${errors} warnings=${warnings} — from files you just edited`,
    ...renderDiagnosticLines(diagnostics, cwd, maxMessages),
  ].join("\n");
}

/** Out-of-band next-turn advisory for diagnostics that arrived after the result. */
export function formatDiagnosticsNotice(
  diagnostics: readonly LspWriteAfterDiagnostic[],
  cwd: string,
  maxMessages: number,
): string {
  const { errors, warnings } = severityCounts(diagnostics);
  return [
    `[LspDiagnostics] errors=${errors} warnings=${warnings} — diagnostics for files you edited last turn`,
    "(arrived after the tool result; advisory, verify against current source before acting)",
    ...renderDiagnosticLines(diagnostics, cwd, maxMessages),
  ].join("\n");
}

/** Sentinel returned by the inline race when the diagnostics fetch outran its budget. */
const INLINE_TIMEOUT = "timeout" as const;

export type RaceInlineDiagnostics = (
  fetchPromise: Promise<LspWriteAfterDiagnosticsResult>,
  budgetMs: number,
) => Promise<LspWriteAfterDiagnosticsResult | typeof INLINE_TIMEOUT>;

function defaultRaceInline(
  fetchPromise: Promise<LspWriteAfterDiagnosticsResult>,
  budgetMs: number,
): Promise<LspWriteAfterDiagnosticsResult | typeof INLINE_TIMEOUT> {
  const timeout = new Promise<typeof INLINE_TIMEOUT>((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(INLINE_TIMEOUT), budgetMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  });
  return Promise.race([fetchPromise, timeout]);
}

interface LspWriteAfterDeps {
  readonly runDiagnostics?: typeof runLspWriteAfterDiagnostics;
  /** Injectable inline-vs-deferred race. Test seam; default races fetch against a timer. */
  readonly raceInline?: RaceInlineDiagnostics;
}

/**
 * Register the write-after-diagnostics interceptor on the internal
 * `hosted_behavior` plugin. Reuses its existing `tool_result.write` and
 * `assistant_message.enqueue` capabilities — no new capability, no new tape
 * event (the inline block rides the tool-result content; the slow-path advisory
 * is an in-memory next-turn custom message).
 */
export function registerLspWriteAfterDiagnostics(
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
  deps: LspWriteAfterDeps = {},
): void {
  const config = runtime.config.lsp;
  const ledger = new DiagnosticsLedger();
  const runDiagnostics = deps.runDiagnostics ?? runLspWriteAfterDiagnostics;
  const raceInline = deps.raceInline ?? defaultRaceInline;

  extensionApi.on("session_compact", () => {
    ledger.reset();
    return undefined;
  });
  extensionApi.on("session_shutdown", () => {
    ledger.reset();
    return undefined;
  });

  extensionApi.on("tool_result", async (event, ctx) => {
    if (!config.diagnosticsOnApply) {
      return undefined;
    }
    if (event.toolName !== "source_patch_apply" || event.isError) {
      return undefined;
    }
    const details = asRecord(event.details);
    if (!details || details.status !== "applied") {
      return undefined;
    }
    const appliedPaths = Array.isArray(details.appliedPaths)
      ? details.appliedPaths.filter((path): path is string => typeof path === "string")
      : [];
    if (appliedPaths.length === 0) {
      return undefined;
    }

    const cwd = ctx.cwd || runtime.identity.cwd;
    const versionsAtDispatch = appliedPaths.map((path) => getFileMutationVersion(path));
    const fetchPromise = runDiagnostics({
      cwd,
      absPaths: appliedPaths,
      timeoutMs: config.deferredBudgetMs,
      signal: ctx.signal,
    });

    const inline = await raceInline(fetchPromise, config.inlineBudgetMs);
    if (inline !== INLINE_TIMEOUT) {
      const result = inline;
      if (!result.available || result.diagnostics.length === 0) {
        return undefined;
      }
      const fresh = ledger.reduce(result.diagnostics);
      if (fresh.length === 0) {
        return undefined;
      }
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: formatDiagnosticsBlock(fresh, cwd, config.maxMessages) },
        ],
      };
    }

    // Slow server: hand off. The result is delivered as a next-turn advisory,
    // after dropping any file a newer apply superseded and filtering already-
    // reported findings.
    void fetchPromise
      .then((result) => {
        if (!result.available || result.diagnostics.length === 0) {
          return;
        }
        const currentPaths = dropStaleDiagnostics(
          result.diagnostics,
          appliedPaths,
          versionsAtDispatch,
        );
        const fresh = ledger.reduce(currentPaths);
        if (fresh.length === 0) {
          return;
        }
        extensionApi.sendMessage(
          {
            customType: LSP_WRITE_AFTER_DIAGNOSTICS_MESSAGE_TYPE,
            content: formatDiagnosticsNotice(fresh, cwd, config.maxMessages),
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      })
      .catch(() => {
        // Best-effort: diagnostics never gate a turn.
      });
    return undefined;
  });
}
