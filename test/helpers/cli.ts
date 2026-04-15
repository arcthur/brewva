import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { repoRoot } from "./workspace.js";

const CLI_ENTRYPOINT = "packages/brewva-cli/src/index.ts";

export type CliRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

export function runCliSync(
  workspace: string,
  args: string[],
  options?: {
    input?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
    env?: NodeJS.ProcessEnv;
  },
): SpawnSyncReturns<string> {
  const env = { ...process.env };
  if (options?.env) {
    Object.assign(env, options.env);
  }

  return spawnSync("bun", [CLI_ENTRYPOINT, "--cwd", workspace, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options?.input,
    timeout: options?.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: options?.maxBufferBytes ?? 64 * 1024 * 1024,
    env,
  });
}

export async function runCli(
  workspace: string,
  args: string[],
  options?: {
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CliRunResult> {
  const env = { ...process.env };
  if (options?.env) {
    Object.assign(env, options.env);
  }

  return await new Promise<CliRunResult>((resolveRun) => {
    const child = spawn("bun", [CLI_ENTRYPOINT, "--cwd", workspace, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CliRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveRun(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      settle({
        status: null,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (status, signal) => {
      settle({
        status,
        stdout,
        stderr,
        signal,
      });
    });

    if (typeof options?.input === "string" && child.stdin) {
      child.stdin.write(options.input);
    }
    child.stdin?.end();

    timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        settle({
          status: null,
          stdout,
          stderr,
          error: new Error(`CLI timed out after ${options?.timeoutMs ?? 10 * 60 * 1000}ms`),
        });
      },
      options?.timeoutMs ?? 10 * 60 * 1000,
    );
    timeout.unref?.();
  });
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

export function assertCliSuccess(
  result: Pick<CliRunResult, "status" | "stdout" | "stderr" | "error">,
  label: string,
): void {
  if (result.status === 0 && result.error === undefined) return;
  const lines = [
    `[${label}] CLI exited with status ${result.status ?? "null"}`,
    `[${label}] error: ${result.error ? String(result.error) : "none"}`,
    `[${label}] stdout:`,
    (result.stdout ?? "").trim().slice(0, 2000),
    `[${label}] stderr:`,
    (result.stderr ?? "").trim().slice(0, 2000),
  ];
  throw new Error(lines.join("\n"));
}

const RATE_LIMIT_PATTERNS = [
  "resource_exhausted",
  "quota exceeded",
  "too many requests",
  '"code":429',
  "rate limit",
  "retry in",
];

export function hasProviderRateLimitText(...chunks: Array<string | undefined>): boolean {
  const normalized = chunks
    .filter((chunk): chunk is string => typeof chunk === "string")
    .join("\n")
    .toLowerCase();
  if (!normalized) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function hasProviderRateLimitResult(result: SpawnSyncReturns<string>): boolean {
  return hasProviderRateLimitText(result.stdout, result.stderr, result.error?.message);
}

export function skipLiveForProviderRateLimit(
  label: string,
  ...chunks: Array<string | undefined>
): boolean {
  if (!hasProviderRateLimitText(...chunks)) {
    return false;
  }
  console.warn(
    `[${label}] live assertion skipped because upstream model quota/rate-limit is exhausted`,
  );
  return true;
}

export function skipLiveForProviderRateLimitResult(
  label: string,
  result: SpawnSyncReturns<string>,
): boolean {
  return skipLiveForProviderRateLimit(label, result.stdout, result.stderr, result.error?.message);
}
