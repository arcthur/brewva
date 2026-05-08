import { spawn } from "node:child_process";
import type {
  BrowserCommandExecution,
  BrowserCommandResult,
  BrowserInvocation,
  BrowserToolDeps,
} from "./types.js";

const DEFAULT_BROWSER_COMMAND = "agent-browser";

function buildCommandArgs(sessionName: string, args: readonly string[]): string[] {
  return ["--session", sessionName, ...args];
}

export async function runAgentBrowserCommand(
  input: BrowserInvocation & { signal?: AbortSignal | null },
  deps: BrowserToolDeps = {},
): Promise<BrowserCommandResult> {
  return await new Promise<BrowserCommandResult>((resolvePromise, rejectPromise) => {
    const command = deps.command ?? DEFAULT_BROWSER_COMMAND;
    const args = buildCommandArgs(input.sessionName, input.args);
    const spawnImpl = deps.spawnImpl ?? spawn;
    const child = spawnImpl(command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore abort-time kill failures
        }
      }
    };

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise({
        exitCode: typeof code === "number" ? code : aborted ? 130 : -1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        terminationReason: aborted ? "abort" : "process_exit",
      });
    });
  });
}

export async function executeBrowserCommand(
  input: BrowserInvocation & { signal?: AbortSignal | null },
  deps: BrowserToolDeps = {},
): Promise<BrowserCommandExecution> {
  try {
    const result = await runAgentBrowserCommand(input, deps);
    if (result.exitCode === 0) {
      return {
        ok: true,
        ...input,
        ...result,
      };
    }
    return {
      ok: false,
      ...input,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      terminationReason: result.terminationReason,
      failureKind: "command_failed",
    };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown } | undefined;
    return {
      ok: false,
      ...input,
      exitCode: null,
      stdout: "",
      stderr: "",
      terminationReason: "spawn_error",
      failureKind: "spawn_error",
      errorCode: typeof candidate?.code === "string" ? candidate.code : undefined,
      errorMessage:
        typeof candidate?.message === "string"
          ? candidate.message
          : "agent-browser command could not be launched.",
    };
  }
}

export function buildInvocationMetadata(result: BrowserCommandExecution): Record<string, unknown> {
  return {
    sessionName: result.sessionName,
    cwd: result.cwd,
    args: [...result.args],
    exitCode: result.exitCode,
    terminationReason: result.terminationReason,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    errorCode: result.ok ? undefined : result.errorCode,
  };
}
