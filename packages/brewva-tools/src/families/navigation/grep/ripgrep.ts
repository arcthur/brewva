import { spawn } from "node:child_process";
import type { GrepCase, GrepRunResult } from "./types.js";

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
