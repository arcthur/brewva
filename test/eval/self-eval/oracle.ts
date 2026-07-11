import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SelfEvalOracle } from "./types.js";

/** Bound the oracle's own subprocess so a hung test cannot wedge the report job. */
const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/**
 * Run a fixture's post-run oracle over its FINAL workspace and decide task
 * success. Deterministic given the workspace (a `command` oracle spawns the
 * fixture's own test; a `readonly_unchanged` oracle compares bytes), and it never
 * needs a provider — so it is unit-testable over staged good/bad workspaces
 * without a live run. The caller only invokes this on a `completed` turn; an
 * unfinished run is `terminal_incomplete` and never reaches the oracle.
 */
export async function runFixtureOracle(input: {
  readonly oracle: SelfEvalOracle;
  readonly workspace: string;
  /** The fixture's originally staged files, for the `readonly_unchanged` check. */
  readonly stagedFiles: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<"task_passed" | "task_failed"> {
  if (input.oracle.kind === "readonly_unchanged") {
    return checkReadonlyUnchanged(input.oracle.paths, input.workspace, input.stagedFiles);
  }
  return runCommandOracle(
    input.oracle.command,
    input.workspace,
    input.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
  );
}

function checkReadonlyUnchanged(
  paths: readonly string[],
  workspace: string,
  stagedFiles: Readonly<Record<string, string>>,
): "task_passed" | "task_failed" {
  for (const path of paths) {
    const staged = stagedFiles[path];
    // A path the oracle guards must have been staged; a missing baseline is a
    // fixture authoring error, surfaced as a failing task rather than a pass.
    if (staged === undefined) return "task_failed";
    let current: string;
    try {
      current = readFileSync(join(workspace, path), "utf8");
    } catch {
      // The file the task was told NOT to touch is gone — the constraint broke.
      return "task_failed";
    }
    if (current !== staged) return "task_failed";
  }
  return "task_passed";
}

async function runCommandOracle(
  command: readonly string[],
  workspace: string,
  timeoutMs: number,
): Promise<"task_passed" | "task_failed"> {
  if (command.length === 0) return "task_failed";
  const child = Bun.spawn([...command], {
    cwd: workspace,
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const exitCode = await child.exited;
    return !timedOut && exitCode === 0 ? "task_passed" : "task_failed";
  } finally {
    clearTimeout(killTimer);
  }
}
