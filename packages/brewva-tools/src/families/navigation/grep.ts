import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { Type } from "@sinclair/typebox";
import { recordSourceSnapshot, toSourceFileResourceUri } from "../../internal/source-patch-gate.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { recordToolRuntimeEvent } from "../../runtime-port/extensions.js";
import { getToolSessionId } from "../../runtime-port/parallel-read.js";
import {
  describeRuntimeArtifactReadRejection,
  describeTargetScopeRejection,
  isPathInsideRoots,
  resolveReadableScopedPath,
  resolveRuntimeArtifactReadRejection,
  resolveToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { errTextResult, okTextResult, textResultForOutcome } from "../../utils/result.js";
import {
  buildAdvisorHeader,
  buildGrepSourceSuggestions,
  deriveBroadenedPaths,
  finalizeSuggestionItems,
  rerankGroupedLines,
  resolveSuggestionMode,
} from "./grep/advisor.js";
import { frecencyForGrepResult, getSearchEngine } from "./grep/engine/index.js";
import { isRuntimeArtifactGrepPattern, runRipgrep } from "./grep/ripgrep.js";
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

function normalizeStringList(value: unknown, fallback: readonly string[]): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : fallback;
  return entries
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
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
      glob: Type.Optional(
        Type.Union([
          Type.String({ minLength: 1 }),
          Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
        ]),
      ),
      case: Type.Optional(GREP_CASE_SCHEMA),
      fixed: Type.Optional(Type.Boolean({ default: false })),
      max_lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 200 })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 30000 })),
      workdir: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(runtime, ctx);
      const cwd = params.workdir ? resolve(scope.baseCwd, params.workdir) : scope.baseCwd;
      if (!isPathInsideRoots(cwd, scope.readableRoots)) {
        return errTextResult(
          describeTargetScopeRejection({
            tool: "grep",
            subject: "workdir",
            allowedRoots: scope.readableRoots,
            offending: cwd,
          }),
          {
            ok: false,
            reason: "workdir_outside_target",
            workdir: cwd,
            targetRoots: scope.readableRoots,
          },
        );
      }
      const workdirRuntimeArtifact = resolveRuntimeArtifactReadRejection(cwd, scope);
      if (workdirRuntimeArtifact) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "grep",
            subject: "workdir",
            offending: params.workdir ?? cwd,
          }),
          {
            ok: false,
            reason: workdirRuntimeArtifact.reason,
            workdir: cwd,
            artifact: workdirRuntimeArtifact.artifact,
            artifactRoot: workdirRuntimeArtifact.artifactRoot,
          },
        );
      }
      const maxLines = clampInt(params.max_lines, 200, { min: 1, max: 500 });
      const timeoutMs = clampInt(params.timeout_ms, 30_000, { min: 100, max: 120_000 });

      const query = params.query.trim();
      const requestedPaths = normalizeStringList(params.paths, ["."]);
      const paths: string[] = [];
      for (const entry of requestedPaths.length > 0 ? requestedPaths : ["."]) {
        const runtimeArtifact = resolveRuntimeArtifactReadRejection(entry, scope, {
          relativeTo: cwd,
        });
        if (runtimeArtifact) {
          return errTextResult(
            describeRuntimeArtifactReadRejection({
              tool: "grep",
              subject: "path",
              offending: entry,
            }),
            {
              ok: false,
              reason: runtimeArtifact.reason,
              path: entry,
              artifact: runtimeArtifact.artifact,
              artifactRoot: runtimeArtifact.artifactRoot,
            },
          );
        }
        const absolutePath = resolveReadableScopedPath(entry, scope, { relativeTo: cwd });
        if (!absolutePath) {
          return errTextResult(
            describeTargetScopeRejection({
              tool: "grep",
              subject: "path",
              allowedRoots: scope.readableRoots,
              offending: entry,
            }),
            {
              ok: false,
              reason: "path_outside_target",
              path: entry,
              targetRoots: scope.readableRoots,
            },
          );
        }
        const relativePath = relative(cwd, absolutePath);
        paths.push(
          relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : absolutePath,
        );
      }
      const globs = normalizeStringList(params.glob, []);
      const runtimeArtifactGlob = globs.find((glob) => isRuntimeArtifactGrepPattern(glob));
      if (runtimeArtifactGlob) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "grep",
            subject: "path",
            offending: runtimeArtifactGlob,
          }),
          {
            ok: false,
            reason: "runtime_artifact_read_denied",
            glob: runtimeArtifactGlob,
            artifact: "tape",
          },
        );
      }
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
        const engine = getSearchEngine(options);
        const runAttempt = async (
          attemptQuery: string,
          attemptPaths: string[],
          extra?: {
            fixed?: boolean;
            forceIgnoreCase?: boolean;
          },
        ): Promise<GrepRunResult> => {
          return engine.grep({
            cwd,
            query: attemptQuery,
            paths: attemptPaths,
            globs,
            caseMode,
            fixed: extra?.fixed ?? params.fixed ?? false,
            forceIgnoreCase: extra?.forceIgnoreCase ?? false,
            maxLines,
            timeoutMs,
            signal,
          });
        };

        const baseHeader = [
          "# Grep",
          `- query: ${query}`,
          `- workdir: ${cwd}`,
          `- paths: ${paths.length > 0 ? paths.join(", ") : "."}`,
          globs.length > 0 ? `- glob: ${globs.join(", ")}` : null,
        ].filter(Boolean) as string[];

        const anchorMatchedLines = (lines: string[]) => {
          // First pass: resolve each match to its file + line. Group the shown
          // match lines per file so each snapshot's seen set is exactly the lines
          // grep surfaced — an edit built from grep output may only touch a line
          // grep actually showed, not any other line of the matched file.
          const parsed = lines.map((line) => {
            const location = parseGrepLocationLine(line);
            if (!location) {
              return { line, location: null };
            }
            const absolutePath = resolveReadableScopedPath(location.path, scope, {
              relativeTo: cwd,
            });
            if (!absolutePath || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
              return { line, location: null };
            }
            return { line, location: { ...location, absolutePath } };
          });
          const seenByPath = new Map<string, Set<number>>();
          for (const entry of parsed) {
            if (entry.location) {
              const seen = seenByPath.get(entry.location.absolutePath) ?? new Set<number>();
              seen.add(entry.location.line);
              seenByPath.set(entry.location.absolutePath, seen);
            }
          }
          const snapshots = new Map<string, ReturnType<typeof recordSourceSnapshot>>();
          for (const [absolutePath, seen] of seenByPath) {
            const sourceText = readSourceTextCached(absolutePath).sourceText;
            snapshots.set(
              absolutePath,
              recordSourceSnapshot({
                uri: toSourceFileResourceUri(scope, absolutePath),
                path: absolutePath,
                sourceText,
                runtime,
                sessionId,
                seenLines: [...seen].toSorted((left, right) => left - right),
              }),
            );
          }
          // Second pass: the line number is the anchor now, so a resolvable match
          // renders as path:line:content; unresolved lines pass through untouched.
          const anchoredLines = parsed.map((entry) => {
            if (!entry.location) {
              return entry.line;
            }
            const anchor = snapshots.get(entry.location.absolutePath)?.anchors[
              entry.location.line - 1
            ];
            return anchor
              ? `${entry.location.path}:${anchor.line}:${entry.location.content}`
              : entry.line;
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
          return okTextResult([...header, "", ...anchored.lines].join("\n"), {
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
            frecencyByPath: frecencyForGrepResult(result),
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
            return okTextResult(
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

          return okTextResult(
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
        return errTextResult(
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
        const message = toErrorMessage(error);
        const notFound = /ENOENT|not found|spawn rg/i.test(message);
        const hint = notFound ? " (install ripgrep: rg)" : "";
        return errTextResult(`grep failed: ${message}${hint}`, {
          ok: false,
          error: message,
          hint,
        });
      }
    },
  });
}

export function createGlobTool(options: GrepToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "glob");

  return define({
    name: "glob",
    label: "Glob",
    description: "Find files by glob pattern with bounded output.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 200 })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 30000 })),
      workdir: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(runtime, ctx);
      const cwd = params.workdir ? resolve(scope.baseCwd, params.workdir) : scope.baseCwd;
      if (!isPathInsideRoots(cwd, scope.readableRoots)) {
        return errTextResult(
          describeTargetScopeRejection({
            tool: "glob",
            subject: "workdir",
            allowedRoots: scope.readableRoots,
            offending: cwd,
          }),
          {
            ok: false,
            reason: "workdir_outside_target",
            workdir: cwd,
            targetRoots: scope.readableRoots,
          },
        );
      }
      const workdirRuntimeArtifact = resolveRuntimeArtifactReadRejection(cwd, scope);
      if (workdirRuntimeArtifact) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "glob",
            subject: "workdir",
            offending: params.workdir ?? cwd,
          }),
          {
            ok: false,
            reason: workdirRuntimeArtifact.reason,
            workdir: cwd,
            artifact: workdirRuntimeArtifact.artifact,
            artifactRoot: workdirRuntimeArtifact.artifactRoot,
          },
        );
      }

      const pattern = params.pattern.trim();
      if (isRuntimeArtifactGrepPattern(pattern)) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "glob",
            subject: "path",
            offending: pattern,
          }),
          {
            ok: false,
            reason: "runtime_artifact_read_denied",
            pattern,
            artifact: "tape",
          },
        );
      }
      const maxResults = clampInt(params.max_results, 200, { min: 1, max: 500 });
      const timeoutMs = clampInt(params.timeout_ms, 30_000, { min: 100, max: 120_000 });
      const requestedPaths = normalizeStringList(params.paths, ["."]);
      const paths: string[] = [];
      for (const entry of requestedPaths.length > 0 ? requestedPaths : ["."]) {
        const runtimeArtifact = resolveRuntimeArtifactReadRejection(entry, scope, {
          relativeTo: cwd,
        });
        if (runtimeArtifact) {
          return errTextResult(
            describeRuntimeArtifactReadRejection({
              tool: "glob",
              subject: "path",
              offending: entry,
            }),
            {
              ok: false,
              reason: runtimeArtifact.reason,
              path: entry,
              artifact: runtimeArtifact.artifact,
              artifactRoot: runtimeArtifact.artifactRoot,
            },
          );
        }
        const absolutePath = resolveReadableScopedPath(entry, scope, { relativeTo: cwd });
        if (!absolutePath) {
          return errTextResult(
            describeTargetScopeRejection({
              tool: "glob",
              subject: "path",
              allowedRoots: scope.readableRoots,
              offending: entry,
            }),
            {
              ok: false,
              reason: "path_outside_target",
              path: entry,
              targetRoots: scope.readableRoots,
            },
          );
        }
        const relativePath = relative(cwd, absolutePath);
        paths.push(
          relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : absolutePath,
        );
      }

      try {
        const engine = getSearchEngine(options);
        const result = await engine.glob({
          cwd,
          pattern,
          paths,
          maxResults,
          timeoutMs,
          signal,
        });
        const sessionId = getToolSessionId(ctx);
        const discoveryPayload = buildReadPathDiscoveryObservationPayload({
          baseCwd: scope.baseCwd,
          toolName: "glob",
          evidenceKind: "file_glob",
          observedPaths: result.lines,
        });
        if (sessionId && discoveryPayload) {
          recordToolRuntimeEvent(runtime, {
            sessionId,
            type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
            payload: discoveryPayload,
          });
        }

        const header = [
          "# Glob",
          `- pattern: ${pattern}`,
          `- workdir: ${cwd}`,
          `- paths: ${paths.length > 0 ? paths.join(", ") : "."}`,
          `- exit_code: ${result.exitCode}`,
          `- matches_shown: ${result.lines.length}`,
          `- truncated: ${result.truncated}`,
          `- timed_out: ${result.timedOut}`,
        ];
        if (result.exitCode === 0) {
          return okTextResult([...header, "", ...result.lines].join("\n"), {
            ok: true,
            ...result,
          });
        }
        if (result.exitCode === 1) {
          return textResultForOutcome("inconclusive", [...header, "", "(no matches)"].join("\n"), {
            ok: true,
            ...result,
          });
        }

        const stderr = result.stderr ? `\n\nstderr:\n${result.stderr}` : "";
        return errTextResult([...header, "", "(rg failed)", stderr.trim()].join("\n").trim(), {
          ok: false,
          ...result,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        const notFound = /ENOENT|not found|spawn rg/i.test(message);
        const hint = notFound ? " (install ripgrep: rg)" : "";
        return errTextResult(`glob failed: ${message}${hint}`, {
          ok: false,
          error: message,
          hint,
        });
      }
    },
  });
}
