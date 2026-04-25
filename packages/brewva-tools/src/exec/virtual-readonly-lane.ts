import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  summarizeShellCommandAnalysis,
  summarizeVirtualReadonlyEligibility,
  type ShellCommandAnalysis,
  type VirtualReadonlyEligibility,
} from "@brewva/brewva-runtime";
import {
  ExecAbortedError,
  ExecCommandFailedError,
  execDisplayResult,
  isPathInsideRoot,
  SHELL_ARGS,
  SHELL_COMMAND,
} from "./shared.js";

const VIRTUAL_READONLY_OUTPUT_LIMIT_BYTES = 4_000_000;
const VIRTUAL_READONLY_DEFAULT_TIMEOUT_SEC = 30;
const VIRTUAL_READONLY_MAX_MATERIALIZED_BYTES = 128_000_000;
const VIRTUAL_READONLY_MAX_MATERIALIZED_ENTRIES = 20_000;
const VIRTUAL_READONLY_TEMP_PREFIX = "brewva-vro-";
const VIRTUAL_READONLY_ENV_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

interface VirtualReadonlyWorkspace {
  executionCwd: string;
  materializedPaths: string[];
  materializedBytes: number;
  materializedEntries: number;
  cleanup(): Promise<void>;
}

interface VirtualReadonlyMaterializationPlan {
  candidates: string[];
}

export class VirtualReadonlyMaterializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VirtualReadonlyMaterializationError";
    this.code = code;
  }
}

function buildVirtualReadonlyEnv(): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  env.PATH = VIRTUAL_READONLY_ENV_PATH;
  env.HOME = tmpdir();
  env.LANG = "C";
  env.LC_ALL = "C";
  env.NO_COLOR = "1";
  return env;
}

function buildVirtualReadonlyMaterializationPlan(
  virtualReadonly: VirtualReadonlyEligibility,
): VirtualReadonlyMaterializationPlan {
  if (!virtualReadonly.eligible) {
    const blocked = virtualReadonly.blockedReasons[0];
    throw new VirtualReadonlyMaterializationError(
      blocked?.code ?? "virtual_readonly_not_eligible",
      blocked?.detail ?? "Virtual readonly route is not eligible for this command.",
    );
  }

  return { candidates: [...virtualReadonly.materializedCandidates] };
}

async function copyPathIntoVirtualWorkspace(input: {
  sourcePath: string;
  destinationPath: string;
  sourceRoot: string;
  counters: { bytes: number; entries: number };
}): Promise<void> {
  input.counters.entries += 1;
  if (input.counters.entries > VIRTUAL_READONLY_MAX_MATERIALIZED_ENTRIES) {
    throw new VirtualReadonlyMaterializationError(
      "virtual_readonly_entry_limit",
      `Virtual readonly materialization exceeded ${VIRTUAL_READONLY_MAX_MATERIALIZED_ENTRIES} entries.`,
    );
  }

  const sourceStat = await lstat(input.sourcePath);
  if (sourceStat.isSymbolicLink()) {
    const target = resolve(dirname(input.sourcePath), await readlink(input.sourcePath));
    const realTarget = await realpath(target);
    if (!isPathInsideRoot(realTarget, input.sourceRoot)) {
      throw new VirtualReadonlyMaterializationError(
        "virtual_readonly_symlink_escape",
        `Virtual readonly refused symlink outside target root: ${input.sourcePath}`,
      );
    }
    await copyPathIntoVirtualWorkspace({
      sourcePath: realTarget,
      destinationPath: input.destinationPath,
      sourceRoot: input.sourceRoot,
      counters: input.counters,
    });
    return;
  }

  if (sourceStat.isDirectory()) {
    await mkdir(input.destinationPath, { recursive: true });
    const entries = await readdir(input.sourcePath);
    for (const entry of entries) {
      await copyPathIntoVirtualWorkspace({
        sourcePath: join(input.sourcePath, entry),
        destinationPath: join(input.destinationPath, entry),
        sourceRoot: input.sourceRoot,
        counters: input.counters,
      });
    }
    return;
  }

  if (!sourceStat.isFile()) {
    throw new VirtualReadonlyMaterializationError(
      "virtual_readonly_special_file",
      `Virtual readonly refused special file: ${input.sourcePath}`,
    );
  }

  input.counters.bytes += sourceStat.size;
  if (input.counters.bytes > VIRTUAL_READONLY_MAX_MATERIALIZED_BYTES) {
    throw new VirtualReadonlyMaterializationError(
      "virtual_readonly_size_limit",
      `Virtual readonly materialization exceeded ${VIRTUAL_READONLY_MAX_MATERIALIZED_BYTES} bytes.`,
    );
  }

  await mkdir(dirname(input.destinationPath), { recursive: true });
  await copyFile(input.sourcePath, input.destinationPath);
}

async function createVirtualReadonlyWorkspace(
  sourceCwd: string,
  plan: VirtualReadonlyMaterializationPlan,
): Promise<VirtualReadonlyWorkspace> {
  const executionCwd = await mkdtemp(join(tmpdir(), VIRTUAL_READONLY_TEMP_PREFIX));
  const counters = { bytes: 0, entries: 0 };
  const materializedPaths: string[] = [];

  try {
    for (const candidate of plan.candidates) {
      const sourcePath = resolve(sourceCwd, candidate);
      if (!isPathInsideRoot(sourcePath, sourceCwd)) {
        throw new VirtualReadonlyMaterializationError(
          "virtual_readonly_path_escape",
          `Virtual readonly path escapes target root: ${candidate}`,
        );
      }

      try {
        await stat(sourcePath);
      } catch {
        continue;
      }

      await copyPathIntoVirtualWorkspace({
        sourcePath,
        destinationPath: join(executionCwd, candidate),
        sourceRoot: sourceCwd,
        counters,
      });
      materializedPaths.push(candidate);
    }

    return {
      executionCwd,
      materializedPaths,
      materializedBytes: counters.bytes,
      materializedEntries: counters.entries,
      async cleanup() {
        await rm(executionCwd, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await rm(executionCwd, { force: true, recursive: true });
    throw error;
  }
}

export async function executeVirtualReadonlyCommand(input: {
  command: string;
  commandPolicy: ShellCommandAnalysis;
  virtualReadonly: VirtualReadonlyEligibility;
  cwd: string;
  timeoutSec?: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw new ExecAbortedError();
  }

  const materializationPlan = buildVirtualReadonlyMaterializationPlan(input.virtualReadonly);
  const workspace = await createVirtualReadonlyWorkspace(input.cwd, materializationPlan);
  const startedAt = Date.now();
  const commandPolicy = summarizeShellCommandAnalysis(input.commandPolicy);
  const virtualReadonly = summarizeVirtualReadonlyEligibility(input.virtualReadonly);

  try {
    return await new Promise<ReturnType<typeof execDisplayResult>>(
      (resolveResult, rejectResult) => {
        const child = spawn(SHELL_COMMAND, [...SHELL_ARGS, input.command], {
          cwd: workspace.executionCwd,
          env: buildVirtualReadonlyEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        let aggregated = "";
        let truncated = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          if (input.signal) {
            input.signal.removeEventListener("abort", abortExecution);
          }
        };

        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };

        const append = (chunk: Buffer) => {
          if (aggregated.length >= VIRTUAL_READONLY_OUTPUT_LIMIT_BYTES) {
            truncated = true;
            child.kill("SIGTERM");
            return;
          }
          const next = chunk.toString("utf8");
          const remaining = VIRTUAL_READONLY_OUTPUT_LIMIT_BYTES - aggregated.length;
          if (next.length > remaining) {
            aggregated += next.slice(0, remaining);
            truncated = true;
            child.kill("SIGTERM");
            return;
          }
          aggregated += next;
        };

        function abortExecution() {
          child.kill("SIGTERM");
          settle(() => rejectResult(new ExecAbortedError()));
        }

        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error) => {
          settle(() => rejectResult(error));
        });
        child.on("close", (exitCode, exitSignal) => {
          settle(() => {
            const output = aggregated.trimEnd() || "(no output)";
            if (exitCode === 0) {
              resolveResult(
                execDisplayResult(output, {
                  status: "completed",
                  exitCode,
                  durationMs: Date.now() - startedAt,
                  cwd: input.cwd,
                  command: input.command,
                  backend: "virtual_readonly",
                  evidenceKind: "exploration",
                  verificationEvidence: false,
                  outputTruncated: truncated,
                  isolation: "materialized_workspace_subset",
                  materializedPaths: workspace.materializedPaths,
                  materializedBytes: workspace.materializedBytes,
                  materializedEntries: workspace.materializedEntries,
                  commandPolicy,
                  virtualReadonly,
                }),
              );
              return;
            }

            const exit = exitSignal ? `signal ${exitSignal}` : `code ${exitCode ?? 1}`;
            rejectResult(new Error(`${output}\n\nProcess exited with ${exit}.`));
          });
        });

        const timeoutSec = input.timeoutSec ?? VIRTUAL_READONLY_DEFAULT_TIMEOUT_SEC;
        if (timeoutSec) {
          timeoutHandle = setTimeout(() => {
            child.kill("SIGTERM");
            settle(() =>
              rejectResult(
                new ExecCommandFailedError(
                  `Virtual readonly command timed out after ${timeoutSec} seconds.`,
                  124,
                ),
              ),
            );
          }, timeoutSec * 1_000);
        }

        if (input.signal) {
          input.signal.addEventListener("abort", abortExecution, { once: true });
        }
      },
    );
  } finally {
    await workspace.cleanup();
  }
}
