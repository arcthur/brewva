import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveToolTargetScope, isPathInsideRoots, resolveScopedPath } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema, normalizeStringEnumAlias } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

interface GrepToolOptions extends BrewvaToolOptions {
  ripgrepCommand?: string;
}

type GrepCase = "smart" | "ignore" | "sensitive";
const GREP_CASE_VALUES = ["smart", "insensitive", "sensitive"] as const;
const GREP_CASE_ALIASES = {
  smart_case: "smart",
  "case-insensitive": "insensitive",
  case_insensitive: "insensitive",
  "case-sensitive": "sensitive",
  case_sensitive: "sensitive",
} as const;
const GREP_CASE_SCHEMA = buildStringEnumSchema(GREP_CASE_VALUES, GREP_CASE_ALIASES, {
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
  const normalized = normalizeStringEnumAlias(value, GREP_CASE_VALUES, GREP_CASE_ALIASES);
  if (normalized === "insensitive") {
    return "ignore";
  }
  if (normalized === "sensitive") {
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

export function createGrepTool(options: GrepToolOptions): ToolDefinition {
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

      const args: string[] = ["--line-number", "--no-heading", "--color", "never", "--hidden"];

      for (const glob of globs) {
        args.push("--glob", glob);
      }

      if (params.fixed) {
        args.push("--fixed-strings");
      }

      if (caseMode === "ignore") {
        args.push("--ignore-case");
      } else if (caseMode === "smart") {
        args.push("--smart-case");
      } else if (caseMode === "sensitive") {
        args.push("--case-sensitive");
      }

      args.push("--", query);
      args.push(...(paths.length > 0 ? paths : ["."]));

      try {
        const result = await runRipgrep(
          {
            cwd,
            args,
            maxLines,
            timeoutMs,
            signal,
          },
          {
            command: options.ripgrepCommand,
          },
        );

        const header = [
          "# Grep",
          `- query: ${query}`,
          `- workdir: ${cwd}`,
          `- paths: ${paths.length > 0 ? paths.join(", ") : "."}`,
          globs.length > 0 ? `- glob: ${globs.join(", ")}` : null,
          `- exit_code: ${result.exitCode}`,
          `- matches_shown: ${result.lines.length}`,
          `- truncated: ${result.truncated}`,
          `- timed_out: ${result.timedOut}`,
        ].filter(Boolean);

        if (result.exitCode === 0) {
          return textResult([...header, "", ...result.lines].join("\n"), {
            ok: true,
            ...result,
          });
        }

        // Exit code 1 means "no matches".
        if (result.exitCode === 1) {
          return textResult([...header, "", "(no matches)"].join("\n"), {
            ok: true,
            ...result,
          });
        }

        const stderr = result.stderr ? `\n\nstderr:\n${result.stderr}` : "";
        return failTextResult([...header, "", "(rg failed)", stderr.trim()].join("\n").trim(), {
          ok: false,
          ...result,
        });
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
