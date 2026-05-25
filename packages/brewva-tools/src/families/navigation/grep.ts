import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { Type } from "@sinclair/typebox";
import {
  formatSourceAnchor,
  recordSourceSnapshot,
  toSourceFileResourceUri,
} from "../../internal/source-patch-gate.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { recordToolRuntimeEvent } from "../../runtime-port/extensions.js";
import { getToolSessionId } from "../../runtime-port/parallel-read.js";
import {
  isPathInsideRoots,
  resolveScopedPath,
  resolveToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { failTextResult, textResult } from "../../utils/result.js";
import {
  buildAdvisorHeader,
  buildGrepSourceSuggestions,
  deriveBroadenedPaths,
  finalizeSuggestionItems,
  rerankGroupedLines,
  resolveSuggestionMode,
} from "./grep/advisor.js";
import { buildRipgrepArgs, runRipgrep } from "./grep/ripgrep.js";
import type { GrepAdvisorDetails, GrepCase, GrepRunResult, GrepToolOptions } from "./grep/types.js";
import {
  buildReadPathDiscoveryObservationPayload,
  collectObservedPathsFromLocationLines,
} from "./read-path-discovery.js";
import {
  attachSearchIntentPreviewCandidates,
  buildDelimiterInsensitivePattern,
  buildSearchAdvisorSnapshot,
  normalizeSearchAdvisorPath,
  registerSearchIntent,
} from "./search-advisor.js";
import { readSourceTextCached } from "./source-intelligence/cache.js";

export { runRipgrep };
export type { GrepRunResult };

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

function clampInt(value: unknown, fallback: number, options: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

function parseGrepLocationLine(line: string): {
  readonly path: string;
  readonly line: number;
  readonly content: string;
} | null {
  const match = /^(.*?):(\d+):(.*)$/u.exec(line);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    path: match[1],
    line: Number(match[2]),
    content: match[3] ?? "",
  };
}

export function createGrepTool(options: GrepToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "grep");

  return define({
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
      const scope = resolveToolTargetScope(runtime, ctx);
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
        runtime,
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

        const anchorMatchedLines = (lines: string[]) => {
          const snapshots = new Map<string, ReturnType<typeof recordSourceSnapshot>>();
          const anchoredLines = lines.map((line) => {
            const parsed = parseGrepLocationLine(line);
            if (!parsed) {
              return line;
            }
            const absolutePath = resolveScopedPath(parsed.path, scope, { relativeTo: cwd });
            if (!absolutePath || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
              return line;
            }
            let snapshot = snapshots.get(absolutePath);
            if (!snapshot) {
              const sourceText = readSourceTextCached(absolutePath).sourceText;
              snapshot = recordSourceSnapshot({
                uri: toSourceFileResourceUri(scope, absolutePath),
                path: absolutePath,
                sourceText,
                runtime,
                sessionId,
              });
              snapshots.set(absolutePath, snapshot);
            }
            const anchor = snapshot.anchors[parsed.line - 1];
            return anchor ? `${parsed.path}:${formatSourceAnchor(anchor)}|${parsed.content}` : line;
          });
          return {
            lines: anchoredLines,
            snapshots: [...snapshots.values()],
          };
        };

        const finalizeMatchedResult = (input: {
          result: GrepRunResult;
          advisor: GrepAdvisorDetails;
          lines: string[];
          candidatePaths: string[];
        }) => {
          const anchored = anchorMatchedLines(input.lines);
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
              lines: anchored.lines,
            }),
          });
          if (sessionId && discoveryPayload) {
            recordToolRuntimeEvent(runtime, {
              sessionId,
              type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
              payload: discoveryPayload,
            });
          }
          const header = buildAdvisorHeader(
            [
              ...baseHeader,
              `- exit_code: ${input.result.exitCode}`,
              `- matches_shown: ${anchored.lines.length}`,
              `- truncated: ${input.result.truncated}`,
              `- timed_out: ${input.result.timedOut}`,
              ...anchored.snapshots.map((snapshot) => `- snapshot: ${snapshot.id} ${snapshot.uri}`),
            ],
            input.advisor,
          );
          return textResult([...header, "", ...anchored.lines].join("\n"), {
            ok: true,
            ...input.result,
            advisor: input.advisor,
            snapshots: anchored.snapshots,
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
            runtime,
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
            runtime,
            sessionId,
          });
          const comboMatch = snapshot.getComboMatch({
            toolName: "grep",
            query,
          });
          const sourceSuggestions = await buildGrepSourceSuggestions({
            baseCwd: scope.baseCwd,
            roots: paths.length > 0 ? paths.map((path) => resolve(cwd, path)) : [scope.baseCwd],
            query,
          });
          const suggestionItems = finalizeSuggestionItems({
            comboPath: comboMatch?.filePath,
            sourceSuggestions,
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
