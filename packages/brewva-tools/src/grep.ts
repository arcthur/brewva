import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildReadPathDiscoveryObservationPayload,
  collectObservedPathsFromLocationLines,
} from "./read-path-discovery.js";
import {
  recordToolRuntimeEvent,
  registerToolRuntimeClearStateListener,
} from "./runtime-internal.js";
import {
  attachSearchIntentPreviewCandidates,
  buildDelimiterInsensitivePattern,
  buildSearchAdvisorSnapshot,
  normalizeSearchAdvisorPath,
  registerSearchIntent,
} from "./search-advisor.js";
import { resolveToolTargetScope, isPathInsideRoots, resolveScopedPath } from "./target-scope.js";
import { resolveTocSessionKey } from "./toc-cache.js";
import {
  createTocSearchSessionCacheStore,
  formatLineSpan,
  normalizeRelativePath,
  runTocSearchCore,
  type TocSearchSessionCacheStore,
} from "./toc-search-core.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { getToolSessionId } from "./utils/parallel-read.js";
import { failTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

interface GrepToolOptions extends BrewvaToolOptions {
  ripgrepCommand?: string;
}

type GrepCase = "smart" | "ignore" | "sensitive";
type GrepSuggestionMode = "combo" | "toc" | "path" | "hybrid";
const GREP_CASE_VALUES = ["smart", "insensitive", "sensitive"] as const;
const GREP_CASE_SCHEMA = buildStringEnumSchema(GREP_CASE_VALUES, {
  defaultValue: "smart",
  recommendedValue: "smart",
  guidance:
    "Use smart by default. Use insensitive for case-insensitive search and sensitive for exact-case search.",
  runtimeValueMap: {
    insensitive: "ignore",
  },
});

function normalizeGrepCase(value: unknown): GrepCase {
  if (value === "ignore" || value === "sensitive" || value === "smart") {
    return value;
  }
  if (value === "insensitive") {
    return "ignore";
  }
  if (value === "sensitive") {
    return "sensitive";
  }
  return "smart";
}

export type GrepRunResult = {
  exitCode: number;
  lines: string[];
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  terminationReason: "process_exit" | "truncate" | "timeout" | "abort";
};

type GrepAdvisorStatus =
  | "applied"
  | "skipped"
  | "auto_broadened"
  | "fuzzy_retry"
  | "suggestion_only";

interface GrepAdvisorDetails {
  status: GrepAdvisorStatus;
  signalFiles: number;
  reorderedFiles: number;
  comboMatches: number;
  autoBroaden?: {
    from: string[];
    to: string[];
  };
  fuzzyRetry?: {
    from: string;
    to: string;
  };
  suggestionMode?: GrepSuggestionMode;
}

interface GrepGroupedLines {
  path?: string;
  lines: string[];
  originalOrder: number;
}

interface GrepSuggestionItem {
  path: string;
  text: string;
  source: Exclude<GrepSuggestionMode, "hybrid">;
}

const GREP_LOCATION_PATTERN = /^([^:\n]+):\d+(?::\d+)?(?:\s|:|$)/u;
const GREP_TOC_SUGGESTION_LIMIT = 3;
const GREP_TOC_SUGGESTION_MAX_FILES = 400;
const GREP_TOC_SUGGESTION_MAX_INDEXED_BYTES = 2_000_000;
const GREP_MAX_SUGGESTIONS = 5;

function clampInt(value: unknown, fallback: number, options: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

export async function runRipgrep(
  input: {
    cwd: string;
    args: string[];
    maxLines: number;
    timeoutMs: number;
    signal?: AbortSignal | null;
  },
  options: {
    command?: string;
    spawnImpl?: typeof spawn;
  } = {},
): Promise<GrepRunResult> {
  return await new Promise<GrepRunResult>((resolvePromise, rejectPromise) => {
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(options.command ?? "rg", input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let terminationReason: "truncate" | "timeout" | "abort" | null = null;

    const killChild = (reason: "truncate" | "timeout" | "abort"): void => {
      if (child.exitCode !== null || child.killed) return;
      if (reason === "truncate") truncated = true;
      if (reason === "timeout") timedOut = true;
      terminationReason = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    const timeoutHandle = setTimeout(() => {
      killChild("timeout");
    }, input.timeoutMs);

    const onAbort = (): void => {
      killChild("abort");
    };
    if (input.signal) {
      if (input.signal.aborted) {
        clearTimeout(timeoutHandle);
        killChild("abort");
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (timedOut || truncated) return;
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          lines.push(line);
          if (lines.length >= input.maxLines) {
            killChild("truncate");
            break;
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) {
        stderr = stderr.slice(-16_000);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }

      const exitCode = resolveRipgrepExitCode(code, terminationReason);
      const tail = stdoutBuffer.trimEnd();
      if (tail.length > 0 && lines.length < input.maxLines) {
        lines.push(tail);
      }

      resolvePromise({
        exitCode,
        lines,
        stderr: stderr.trimEnd(),
        truncated,
        timedOut,
        terminationReason: terminationReason ?? "process_exit",
      });
    });
  });
}

function resolveRipgrepExitCode(
  code: number | null,
  terminationReason: "truncate" | "timeout" | "abort" | null,
): number {
  if (typeof code === "number") return code;
  if (terminationReason === "truncate") return 0;
  if (terminationReason === "timeout") return 124;
  if (terminationReason === "abort") return 130;
  return -1;
}

function buildRipgrepArgs(input: {
  query: string;
  paths: string[];
  globs: string[];
  caseMode: GrepCase;
  fixed?: boolean;
  forceIgnoreCase?: boolean;
}): string[] {
  const args: string[] = ["--line-number", "--no-heading", "--color", "never", "--hidden"];

  for (const glob of input.globs) {
    args.push("--glob", glob);
  }

  if (input.fixed) {
    args.push("--fixed-strings");
  }

  if (input.forceIgnoreCase || input.caseMode === "ignore") {
    args.push("--ignore-case");
  } else if (input.caseMode === "smart") {
    args.push("--smart-case");
  } else if (input.caseMode === "sensitive") {
    args.push("--case-sensitive");
  }

  args.push("--", input.query);
  args.push(...(input.paths.length > 0 ? input.paths : ["."]));
  return args;
}

function groupLocationLines(baseCwd: string, lines: string[]): GrepGroupedLines[] {
  const groups: GrepGroupedLines[] = [];
  let current: GrepGroupedLines | undefined;
  let hasUnparsedLine = false;

  for (const line of lines) {
    const match = GREP_LOCATION_PATTERN.exec(line.trim());
    const normalizedPath = match?.[1] ? normalizeSearchAdvisorPath(baseCwd, match[1]) : undefined;
    if (!normalizedPath) {
      hasUnparsedLine = true;
      groups.push({
        lines: [line],
        originalOrder: groups.length,
      });
      current = undefined;
      continue;
    }
    if (current?.path === normalizedPath) {
      current.lines.push(line);
      continue;
    }
    current = {
      path: normalizedPath,
      lines: [line],
      originalOrder: groups.length,
    };
    groups.push(current);
  }

  if (hasUnparsedLine) {
    return groups;
  }
  return groups;
}

function rerankGroupedLines(input: {
  baseCwd: string;
  query: string;
  lines: string[];
  runtime?: BrewvaToolOptions["runtime"];
  sessionId?: string;
}): {
  lines: string[];
  candidatePaths: string[];
  advisor: GrepAdvisorDetails;
} {
  const snapshot = buildSearchAdvisorSnapshot({
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  const groups = groupLocationLines(input.baseCwd, input.lines);
  if (groups.some((group) => !group.path)) {
    return {
      lines: input.lines,
      candidatePaths: [],
      advisor: {
        status: snapshot.signalFiles > 0 ? "applied" : "skipped",
        signalFiles: snapshot.signalFiles,
        reorderedFiles: 0,
        comboMatches: 0,
      },
    };
  }

  const ranked = groups.map((group) => {
    const score = snapshot.scoreFile({
      toolName: "grep",
      query: input.query,
      filePath: group.path ?? "",
    });
    return {
      path: group.path,
      lines: group.lines,
      originalOrder: group.originalOrder,
      score,
    };
  });

  ranked.sort((left, right) => {
    if (left.score.comboThresholdHit !== right.score.comboThresholdHit) {
      return left.score.comboThresholdHit ? -1 : 1;
    }
    if (left.score.comboBias !== right.score.comboBias) {
      return right.score.comboBias - left.score.comboBias;
    }
    if (left.score.pathScore !== right.score.pathScore) {
      return right.score.pathScore - left.score.pathScore;
    }
    return left.originalOrder - right.originalOrder;
  });

  const reorderedFiles = ranked.filter((group, index) => group.originalOrder !== index).length;
  const candidatePaths = ranked
    .map((group) => group.path)
    .filter((path): path is string => Boolean(path));
  return {
    lines: ranked.flatMap((group) => group.lines),
    candidatePaths,
    advisor: {
      status:
        reorderedFiles > 0 ||
        snapshot.signalFiles > 0 ||
        ranked.some((group) => group.score.comboHits > 0)
          ? "applied"
          : "skipped",
      signalFiles: snapshot.signalFiles,
      reorderedFiles,
      comboMatches: Math.max(0, ...ranked.map((group) => group.score.comboHits)),
    },
  };
}

function deriveBroadenedPaths(cwd: string, paths: string[]): string[] {
  const broadened = new Set<string>();
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized === ".") {
      broadened.add(".");
      continue;
    }
    const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
    let broadenedPath = dirname(absolutePath);
    try {
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        broadenedPath = dirname(absolutePath);
      }
    } catch {
      broadenedPath = dirname(absolutePath);
    }
    const relativePath = relative(cwd, broadenedPath).replaceAll("\\", "/");
    broadened.add(relativePath.length === 0 ? "." : relativePath);
  }
  return [...broadened];
}

function buildAdvisorHeader(header: string[], advisor: GrepAdvisorDetails): string[] {
  const nextHeader = [...header];
  nextHeader.push(`- advisor_status: ${advisor.status}`);
  nextHeader.push(`- advisor_signal_files: ${advisor.signalFiles}`);
  nextHeader.push(`- advisor_reordered_files: ${advisor.reorderedFiles}`);
  if (advisor.autoBroaden) {
    nextHeader.push(`- auto_broadened_from: ${advisor.autoBroaden.from.join(", ")}`);
    nextHeader.push(`- auto_broadened_to: ${advisor.autoBroaden.to.join(", ")}`);
  }
  if (advisor.fuzzyRetry) {
    nextHeader.push(`- fuzzy_retry_from: ${advisor.fuzzyRetry.from}`);
    nextHeader.push(`- fuzzy_retry_to: ${advisor.fuzzyRetry.to}`);
  }
  return nextHeader;
}

function buildGrepTocSuggestions(input: {
  runtime?: BrewvaToolOptions["runtime"];
  sessionId?: string;
  baseCwd: string;
  roots: string[];
  query: string;
  cacheStore: TocSearchSessionCacheStore;
}): GrepSuggestionItem[] {
  const core = runTocSearchCore({
    runtime: input.runtime,
    sessionId: input.sessionId,
    baseDir: input.baseCwd,
    roots: input.roots,
    queryText: input.query,
    limit: GREP_TOC_SUGGESTION_LIMIT,
    cacheStore: input.cacheStore,
    maxCandidateFiles: GREP_TOC_SUGGESTION_MAX_FILES,
    maxIndexedBytes: GREP_TOC_SUGGESTION_MAX_INDEXED_BYTES,
  });
  if (
    core.tokens.length === 0 ||
    core.scopeOverflow ||
    core.noSupportedFiles ||
    core.noAccessibleFiles ||
    core.noIndexableFiles ||
    core.rankedMatches.length === 0
  ) {
    return [];
  }
  return core.rankedMatches.slice(0, GREP_TOC_SUGGESTION_LIMIT).map((match) => {
    const displayPath = normalizeRelativePath(input.baseCwd, match.filePath);
    return {
      path: normalizeSearchAdvisorPath(input.baseCwd, match.filePath) ?? displayPath,
      text: `${displayPath} (toc ${match.kind} ${match.name} @ ${formatLineSpan(match.lineStart, match.lineEnd)})`,
      source: "toc",
    };
  });
}

function finalizeSuggestionItems(input: {
  comboPath?: string;
  hotFiles: string[];
  tocSuggestions: GrepSuggestionItem[];
}): GrepSuggestionItem[] {
  const items: GrepSuggestionItem[] = [];
  if (input.comboPath) {
    items.push({
      path: input.comboPath,
      text: input.comboPath,
      source: "combo",
    });
  }
  items.push(...input.tocSuggestions);
  for (const hotFile of input.hotFiles) {
    items.push({
      path: hotFile,
      text: hotFile,
      source: "path",
    });
  }

  const unique: GrepSuggestionItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.path || seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    unique.push(item);
    if (unique.length >= GREP_MAX_SUGGESTIONS) {
      break;
    }
  }
  return unique;
}

function resolveSuggestionMode(items: GrepSuggestionItem[]): GrepSuggestionMode {
  const sources = [...new Set(items.map((item) => item.source))];
  const primarySource = sources[0];
  if (!primarySource) {
    return "path";
  }
  return sources.length === 1 ? primarySource : "hybrid";
}

export function createGrepTool(options: GrepToolOptions): ToolDefinition {
  const tocSearchCache = createTocSearchSessionCacheStore();
  registerToolRuntimeClearStateListener(options.runtime, (sessionId) => {
    tocSearchCache.delete(resolveTocSessionKey(sessionId));
  });

  return defineBrewvaTool({
    name: "grep",
    label: "Grep",
    description: "Search code using ripgrep (rg) with bounded output.",
    promptGuidelines: [
      "Prefer case=smart by default; use insensitive for case-insensitive search and sensitive for exact-case search.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      glob: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      case: Type.Optional(GREP_CASE_SCHEMA),
      fixed: Type.Optional(Type.Boolean({ default: false })),
      max_lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 200 })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 30000 })),
      workdir: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(options.runtime, ctx);
      const cwd = params.workdir ? resolve(scope.baseCwd, params.workdir) : scope.baseCwd;
      if (!isPathInsideRoots(cwd, scope.allowedRoots)) {
        return failTextResult(
          `grep rejected: workdir escapes target roots (${scope.allowedRoots.join(", ")}).`,
          {
            ok: false,
            reason: "workdir_outside_target",
            workdir: cwd,
            targetRoots: scope.allowedRoots,
          },
        );
      }
      const maxLines = clampInt(params.max_lines, 200, { min: 1, max: 500 });
      const timeoutMs = clampInt(params.timeout_ms, 30_000, { min: 100, max: 120_000 });

      const query = params.query.trim();
      const requestedPaths = (params.paths ?? ["."]).map((entry) => entry.trim()).filter(Boolean);
      const paths: string[] = [];
      for (const entry of requestedPaths.length > 0 ? requestedPaths : ["."]) {
        const absolutePath = resolveScopedPath(entry, scope, { relativeTo: cwd });
        if (!absolutePath) {
          return failTextResult(`grep rejected: path escapes target roots (${entry}).`, {
            ok: false,
            reason: "path_outside_target",
            path: entry,
            targetRoots: scope.allowedRoots,
          });
        }
        const relativePath = relative(cwd, absolutePath);
        paths.push(
          relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : absolutePath,
        );
      }
      const globs = (params.glob ?? []).map((entry) => entry.trim()).filter(Boolean);
      const caseMode = normalizeGrepCase(params.case);
      const sessionId = getToolSessionId(ctx);
      registerSearchIntent({
        runtime: options.runtime,
        sessionId,
        toolName: "grep",
        query,
        requestedPaths: paths
          .map((path) => normalizeSearchAdvisorPath(scope.baseCwd, path))
          .filter((path): path is string => Boolean(path)),
      });

      try {
        const runAttempt = async (
          attemptQuery: string,
          attemptPaths: string[],
          extra?: {
            fixed?: boolean;
            forceIgnoreCase?: boolean;
          },
        ): Promise<GrepRunResult> => {
          return runRipgrep(
            {
              cwd,
              args: buildRipgrepArgs({
                query: attemptQuery,
                paths: attemptPaths,
                globs,
                caseMode,
                fixed: extra?.fixed ?? params.fixed,
                forceIgnoreCase: extra?.forceIgnoreCase,
              }),
              maxLines,
              timeoutMs,
              signal,
            },
            {
              command: options.ripgrepCommand,
            },
          );
        };

        const baseHeader = [
          "# Grep",
          `- query: ${query}`,
          `- workdir: ${cwd}`,
          `- paths: ${paths.length > 0 ? paths.join(", ") : "."}`,
          globs.length > 0 ? `- glob: ${globs.join(", ")}` : null,
        ].filter(Boolean) as string[];

        const finalizeMatchedResult = (input: {
          result: GrepRunResult;
          advisor: GrepAdvisorDetails;
          lines: string[];
          candidatePaths: string[];
        }) => {
          attachSearchIntentPreviewCandidates({
            sessionId,
            toolName: "grep",
            query,
            candidatePaths: input.candidatePaths,
          });
          const discoveryPayload = buildReadPathDiscoveryObservationPayload({
            baseCwd: scope.baseCwd,
            toolName: "grep",
            evidenceKind: "search_match",
            observedPaths: collectObservedPathsFromLocationLines({
              baseCwd: scope.baseCwd,
              lines: input.lines,
            }),
          });
          if (sessionId && discoveryPayload) {
            recordToolRuntimeEvent(options.runtime, {
              sessionId,
              type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
              payload: discoveryPayload,
            });
          }
          const header = buildAdvisorHeader(
            [
              ...baseHeader,
              `- exit_code: ${input.result.exitCode}`,
              `- matches_shown: ${input.lines.length}`,
              `- truncated: ${input.result.truncated}`,
              `- timed_out: ${input.result.timedOut}`,
            ],
            input.advisor,
          );
          return textResult([...header, "", ...input.lines].join("\n"), {
            ok: true,
            ...input.result,
            advisor: input.advisor,
          });
        };

        const rerankAndFinalize = (
          result: GrepRunResult,
          advisorOverrides?: Partial<GrepAdvisorDetails>,
        ) => {
          const reranked = rerankGroupedLines({
            baseCwd: scope.baseCwd,
            query,
            lines: result.lines,
            runtime: options.runtime,
            sessionId,
          });
          return finalizeMatchedResult({
            result,
            advisor: { ...reranked.advisor, ...advisorOverrides },
            lines: reranked.lines,
            candidatePaths: reranked.candidatePaths,
          });
        };

        const exactResult = await runAttempt(query, paths);
        if (exactResult.exitCode === 0 && exactResult.lines.length > 0) {
          return rerankAndFinalize(exactResult);
        }

        let finalNoMatchResult = exactResult;
        let retryPaths = paths;
        let autoBroaden:
          | {
              from: string[];
              to: string[];
            }
          | undefined;
        if (exactResult.exitCode === 1 && Array.isArray(params.paths) && params.paths.length > 0) {
          const broadenedPaths = deriveBroadenedPaths(cwd, paths);
          if (broadenedPaths.join("\n") !== paths.join("\n")) {
            retryPaths = broadenedPaths;
            autoBroaden = {
              from: paths,
              to: broadenedPaths,
            };
            const broadenedResult = await runAttempt(query, broadenedPaths);
            if (broadenedResult.exitCode === 0 && broadenedResult.lines.length > 0) {
              return rerankAndFinalize(broadenedResult, {
                status: "auto_broadened",
                autoBroaden,
              });
            }
            finalNoMatchResult = broadenedResult;
          }
        }

        const delimiterPattern = buildDelimiterInsensitivePattern(query);
        if (finalNoMatchResult.exitCode === 1 && delimiterPattern) {
          const fallbackResult = await runAttempt(delimiterPattern, retryPaths, {
            fixed: false,
            forceIgnoreCase: true,
          });
          if (fallbackResult.exitCode === 0 && fallbackResult.lines.length > 0) {
            return rerankAndFinalize(fallbackResult, {
              status: "fuzzy_retry",
              ...(autoBroaden ? { autoBroaden } : {}),
              fuzzyRetry: {
                from: query,
                to: delimiterPattern,
              },
            });
          }
          finalNoMatchResult = fallbackResult;
        }

        if (finalNoMatchResult.exitCode === 1) {
          const snapshot = buildSearchAdvisorSnapshot({
            runtime: options.runtime,
            sessionId,
          });
          const comboMatch = snapshot.getComboMatch({
            toolName: "grep",
            query,
          });
          const tocSuggestions = buildGrepTocSuggestions({
            runtime: options.runtime,
            sessionId,
            baseCwd: scope.baseCwd,
            roots: paths.length > 0 ? paths.map((path) => resolve(cwd, path)) : [scope.baseCwd],
            query,
            cacheStore: tocSearchCache,
          });
          const suggestionItems = finalizeSuggestionItems({
            comboPath: comboMatch?.filePath,
            tocSuggestions,
            hotFiles: snapshot.hotFiles.slice(0, 3),
          });

          if (suggestionItems.length > 0) {
            attachSearchIntentPreviewCandidates({
              sessionId,
              toolName: "grep",
              query,
              candidatePaths: suggestionItems.map((item) => item.path),
            });
            const advisor: GrepAdvisorDetails = {
              status: "suggestion_only",
              signalFiles: snapshot.signalFiles,
              reorderedFiles: 0,
              comboMatches: comboMatch?.hitCount ?? 0,
              suggestionMode: resolveSuggestionMode(suggestionItems),
            };
            const header = buildAdvisorHeader(
              [
                ...baseHeader,
                `- exit_code: ${finalNoMatchResult.exitCode}`,
                "- matches_shown: 0",
                `- truncated: ${finalNoMatchResult.truncated}`,
                `- timed_out: ${finalNoMatchResult.timedOut}`,
              ],
              advisor,
            );
            return textResult(
              [
                ...header,
                "",
                "[Suggestions]",
                ...suggestionItems.map((item) => `- ${item.text}`),
              ].join("\n"),
              {
                ok: true,
                ...finalNoMatchResult,
                advisor,
              },
            );
          }

          return textResult(
            [
              ...baseHeader,
              `- exit_code: ${finalNoMatchResult.exitCode}`,
              "- matches_shown: 0",
              `- truncated: ${finalNoMatchResult.truncated}`,
              `- timed_out: ${finalNoMatchResult.timedOut}`,
              "",
              "(no matches)",
            ].join("\n"),
            {
              ok: true,
              ...finalNoMatchResult,
              advisor: {
                status: "skipped",
                signalFiles: snapshot.signalFiles,
                reorderedFiles: 0,
                comboMatches: comboMatch?.hitCount ?? 0,
              },
            },
          );
        }

        const stderr = finalNoMatchResult.stderr ? `\n\nstderr:\n${finalNoMatchResult.stderr}` : "";
        return failTextResult(
          [
            ...baseHeader,
            `- exit_code: ${finalNoMatchResult.exitCode}`,
            `- matches_shown: ${finalNoMatchResult.lines.length}`,
            `- truncated: ${finalNoMatchResult.truncated}`,
            `- timed_out: ${finalNoMatchResult.timedOut}`,
            "",
            "(rg failed)",
            stderr.trim(),
          ]
            .join("\n")
            .trim(),
          {
            ok: false,
            ...finalNoMatchResult,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notFound = /ENOENT|not found|spawn rg/i.test(message);
        const hint = notFound ? " (install ripgrep: rg)" : "";
        return failTextResult(`grep failed: ${message}${hint}`, {
          ok: false,
          error: message,
          hint,
        });
      }
    },
  });
}
