import { spawn } from "node:child_process";
import type { GrepCase, GrepRunResult } from "./types.js";

export const DEFAULT_GREP_MAX_LINE_CHARS = 16_000;
export const DEFAULT_GREP_MAX_OUTPUT_CHARS = 64_000;
export const DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS = [
  "!.brewva/tape/**",
  "!**/.brewva/tape/**",
] as const;

export function isRuntimeArtifactGrepRelativePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return (
    normalized === ".brewva/tape" ||
    normalized.startsWith(".brewva/tape/") ||
    normalized.includes("/.brewva/tape/")
  );
}

export function isRuntimeArtifactGrepPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.startsWith("!")) {
    return false;
  }
  const normalized = trimmed.replaceAll("\\", "/").replace(/^\.\//u, "");
  return /(^|[/,{])\.brewva\/tape(?:$|[/}*,])/u.test(normalized);
}

function clampWithMarker(text: string, maxChars: number, marker: string): string {
  const limit = Math.max(0, Math.trunc(maxChars));
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 0) {
    return marker;
  }
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  return `${text.slice(0, limit - marker.length)}${marker}`;
}

export function createGrepOutputLimiter(input: {
  maxLines: number;
  maxLineChars?: number;
  maxOutputChars?: number;
}): {
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly totalChars: number;
  append(line: string): "accepted" | "full";
} {
  const maxLines = Math.max(1, Math.trunc(input.maxLines));
  const maxLineChars = Math.max(1, Math.trunc(input.maxLineChars ?? DEFAULT_GREP_MAX_LINE_CHARS));
  const maxOutputChars = Math.max(
    1,
    Math.trunc(input.maxOutputChars ?? DEFAULT_GREP_MAX_OUTPUT_CHARS),
  );
  const lines: string[] = [];
  let truncated = false;
  let totalChars = 0;

  return {
    get lines() {
      return lines;
    },
    get truncated() {
      return truncated;
    },
    get totalChars() {
      return totalChars;
    },
    append(line: string) {
      if (line.length === 0) {
        return "accepted";
      }
      if (lines.length >= maxLines || totalChars >= maxOutputChars) {
        truncated = true;
        return "full";
      }

      let bounded = line;
      let stop = false;
      if (bounded.length > maxLineChars) {
        bounded = clampWithMarker(
          bounded,
          maxLineChars,
          ` [grep_line_truncated original_chars=${bounded.length}]`,
        );
        truncated = true;
        stop = true;
      }

      const remaining = maxOutputChars - totalChars;
      if (bounded.length > remaining) {
        bounded = clampWithMarker(
          bounded,
          remaining,
          ` [grep_output_truncated max_chars=${maxOutputChars}]`,
        );
        truncated = true;
        stop = true;
      }

      lines.push(bounded);
      totalChars += bounded.length;

      if (lines.length >= maxLines) {
        truncated = true;
        return "full";
      }
      return stop ? "full" : "accepted";
    },
  };
}

export async function runRipgrep(
  input: {
    cwd: string;
    args: string[];
    maxLines: number;
    timeoutMs: number;
    maxLineChars?: number;
    maxOutputChars?: number;
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

    const limiter = createGrepOutputLimiter({
      maxLines: input.maxLines,
      maxLineChars: input.maxLineChars,
      maxOutputChars: input.maxOutputChars,
    });
    let stdoutBuffer = "";
    let stderr = "";
    let processTruncated = false;
    let timedOut = false;
    let terminationReason: "truncate" | "timeout" | "abort" | null = null;

    const killChild = (reason: "truncate" | "timeout" | "abort"): void => {
      if (child.exitCode !== null || child.killed) return;
      if (reason === "truncate") processTruncated = true;
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
      if (timedOut || processTruncated) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > (input.maxLineChars ?? DEFAULT_GREP_MAX_LINE_CHARS)) {
        const tail = stdoutBuffer.trimEnd();
        if (tail.length > 0) {
          limiter.append(tail);
        }
        stdoutBuffer = "";
        killChild("truncate");
        return;
      }
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          if (limiter.append(line) === "full") {
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
      if (!processTruncated && tail.length > 0) {
        limiter.append(tail);
      }

      resolvePromise({
        exitCode,
        lines: [...limiter.lines],
        stderr: stderr.trimEnd(),
        truncated: processTruncated || limiter.truncated,
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

export function buildRipgrepArgs(input: {
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
  for (const glob of DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS) {
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
