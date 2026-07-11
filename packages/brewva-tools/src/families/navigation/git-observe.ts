import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  describeTargetScopeRejection,
  isPathInsideRoots,
  resolveToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { errTextResult, okTextResult, textResultForOutcome } from "../../utils/result.js";

interface GitObserveToolOptions extends BrewvaToolOptions {
  gitCommand?: string;
}

interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 24_000;

function clampInt(value: unknown, fallback: number, options: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

async function runGitCommand(
  input: {
    cwd: string;
    args: string[];
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal | null;
  },
  options: {
    command?: string;
  } = {},
): Promise<GitRunResult> {
  return await new Promise<GitRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.command ?? "git", input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const finish = (result: GitRunResult) => {
      if (finished) return;
      finished = true;
      resolvePromise(result);
    };

    const stop = (reason: "timeout" | "abort" | "truncate") => {
      if (child.exitCode !== null || child.killed) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "truncate") truncated = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    };

    const timeoutHandle = setTimeout(() => {
      stop("timeout");
    }, input.timeoutMs);

    const onAbort = () => {
      stop("abort");
    };
    if (input.signal) {
      if (input.signal.aborted) {
        clearTimeout(timeoutHandle);
        stop("abort");
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > input.maxOutputChars) {
        stdout = stdout.slice(0, input.maxOutputChars);
        stop("truncate");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > input.maxOutputChars) {
        stderr = stderr.slice(-input.maxOutputChars);
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
      finish({
        exitCode: typeof code === "number" ? code : timedOut ? 124 : 130,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        truncated,
        timedOut,
      });
    });
  });
}

function resolveWorkdir(
  toolName: string,
  options: BrewvaToolOptions["runtime"],
  ctx: unknown,
  value: unknown,
): string {
  const scope = resolveToolTargetScope(options, ctx);
  const workdir =
    typeof value === "string" && value.trim().length > 0
      ? resolve(scope.baseCwd, value.trim())
      : scope.baseCwd;
  if (!isPathInsideRoots(workdir, scope.readableRoots)) {
    throw new Error(
      describeTargetScopeRejection({
        tool: toolName,
        subject: "workdir",
        allowedRoots: scope.readableRoots,
        offending: workdir,
      }),
    );
  }
  return workdir;
}

function renderGitResult(input: {
  cwd: string;
  result: GitRunResult;
  emptyFallback: string;
}): ReturnType<typeof okTextResult> {
  const lines = [
    input.result.stdout || input.emptyFallback,
    input.result.stderr ? `\n[stderr]\n${input.result.stderr}` : "",
    input.result.truncated ? "\n[output truncated]" : "",
    input.result.timedOut ? "\n[command timed out]" : "",
  ]
    .join("")
    .trim();
  const outcomeKind =
    input.result.exitCode === 0 ? "ok" : input.result.exitCode === 1 ? "inconclusive" : "err";
  return textResultForOutcome(outcomeKind, lines, {
    cwd: input.cwd,
    exitCode: input.result.exitCode,
    truncated: input.result.truncated,
    timedOut: input.result.timedOut,
  });
}

export function createGitStatusTool(options: GitObserveToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "git_status");
  return define(
    {
      name: "git_status",
      label: "Git Status",
      description: "Inspect repository status with bounded read-only git output.",
      parameters: Type.Object({
        workdir: Type.Optional(Type.String()),
        short: Type.Optional(Type.Boolean({ default: true })),
        untracked: Type.Optional(Type.Boolean({ default: true })),
        timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 15000 })),
        max_output_chars: Type.Optional(
          Type.Number({ minimum: 200, maximum: 60000, default: DEFAULT_MAX_OUTPUT_CHARS }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let cwd: string;
        try {
          cwd = resolveWorkdir("git_status", runtime, ctx, params.workdir);
        } catch (error) {
          return errTextResult(toErrorMessage(error), {
            ok: false,
          });
        }
        const result = await runGitCommand(
          {
            cwd,
            args: [
              "status",
              params.short === false ? "--branch" : "--short",
              "--branch",
              ...(params.untracked === false ? ["--untracked-files=no"] : []),
            ],
            timeoutMs: clampInt(params.timeout_ms, DEFAULT_TIMEOUT_MS, {
              min: 100,
              max: 120_000,
            }),
            maxOutputChars: clampInt(params.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, {
              min: 200,
              max: 60_000,
            }),
            signal,
          },
          { command: options.gitCommand },
        );
        return renderGitResult({
          cwd,
          result,
          emptyFallback: "git status returned no changes.",
        });
      },
    },
    {
      surface: "base",
      actionClass: "workspace_read",
    },
  );
}

export function createGitDiffTool(options: GitObserveToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "git_diff");
  return define(
    {
      name: "git_diff",
      label: "Git Diff",
      description: "Inspect bounded git diff output without shell access.",
      parameters: Type.Object({
        workdir: Type.Optional(Type.String()),
        staged: Type.Optional(Type.Boolean({ default: false })),
        rev_base: Type.Optional(Type.String()),
        rev_head: Type.Optional(Type.String()),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
        timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 15000 })),
        max_output_chars: Type.Optional(
          Type.Number({ minimum: 200, maximum: 60000, default: DEFAULT_MAX_OUTPUT_CHARS }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let cwd: string;
        try {
          cwd = resolveWorkdir("git_diff", runtime, ctx, params.workdir);
        } catch (error) {
          return errTextResult(toErrorMessage(error), {
            ok: false,
          });
        }
        const paths = Array.isArray(params.paths)
          ? params.paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
          : [];
        const revisionArgs =
          typeof params.rev_base === "string" && typeof params.rev_head === "string"
            ? [params.rev_base.trim(), params.rev_head.trim()]
            : typeof params.rev_base === "string"
              ? [params.rev_base.trim()]
              : [];
        const result = await runGitCommand(
          {
            cwd,
            args: [
              "diff",
              "--no-ext-diff",
              "--submodule=short",
              ...(params.staged === true ? ["--staged"] : []),
              ...revisionArgs,
              ...(paths.length > 0 ? ["--", ...paths] : []),
            ],
            timeoutMs: clampInt(params.timeout_ms, DEFAULT_TIMEOUT_MS, {
              min: 100,
              max: 120_000,
            }),
            maxOutputChars: clampInt(params.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, {
              min: 200,
              max: 60_000,
            }),
            signal,
          },
          { command: options.gitCommand },
        );
        return renderGitResult({
          cwd,
          result,
          emptyFallback: "git diff returned no visible changes.",
        });
      },
    },
    {
      surface: "base",
      actionClass: "workspace_read",
    },
  );
}

export function createGitLogTool(options: GitObserveToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "git_log");
  return define(
    {
      name: "git_log",
      label: "Git Log",
      description: "Inspect recent git history with bounded output.",
      parameters: Type.Object({
        workdir: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
        ref: Type.Optional(Type.String()),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
        timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 15000 })),
        max_output_chars: Type.Optional(
          Type.Number({ minimum: 200, maximum: 60000, default: DEFAULT_MAX_OUTPUT_CHARS }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let cwd: string;
        try {
          cwd = resolveWorkdir("git_log", runtime, ctx, params.workdir);
        } catch (error) {
          return errTextResult(toErrorMessage(error), {
            ok: false,
          });
        }
        const paths = Array.isArray(params.paths)
          ? params.paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
          : [];
        const ref =
          typeof params.ref === "string" && params.ref.trim().length > 0
            ? params.ref.trim()
            : undefined;
        const result = await runGitCommand(
          {
            cwd,
            args: [
              "log",
              "--oneline",
              "--decorate",
              `-n${clampInt(params.limit, 20, { min: 1, max: 100 })}`,
              ...(ref ? [ref] : []),
              ...(paths.length > 0 ? ["--", ...paths] : []),
            ],
            timeoutMs: clampInt(params.timeout_ms, DEFAULT_TIMEOUT_MS, {
              min: 100,
              max: 120_000,
            }),
            maxOutputChars: clampInt(params.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, {
              min: 200,
              max: 60_000,
            }),
            signal,
          },
          { command: options.gitCommand },
        );
        return renderGitResult({
          cwd,
          result,
          emptyFallback: "git log returned no commits.",
        });
      },
    },
    {
      surface: "base",
      actionClass: "workspace_read",
    },
  );
}
