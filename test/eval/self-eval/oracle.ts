import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SelfEvalArchitectureModuleExpectation, SelfEvalOracle } from "./types.js";

/** Bound the oracle's own subprocess so a hung test cannot wedge the report job. */
const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/**
 * Run a fixture's post-run oracle over its FINAL workspace and decide task
 * success. A command oracle never executes the model's workspace test: after the
 * model exits, it creates a fresh verifier directory from frozen fixture data and
 * copies only declared regular subject files from the final workspace. The caller
 * only invokes this on a `completed` turn; an unfinished run is
 * `terminal_incomplete` and never reaches the oracle.
 */
export async function runFixtureOracle(input: {
  readonly oracle: SelfEvalOracle;
  readonly workspace: string;
  /** The fixture's originally staged files, for the `readonly_unchanged` check. */
  readonly stagedFiles: Readonly<Record<string, string>>;
  /** Final assistant text read from the durable tape for response scoring. */
  readonly assistantText?: string;
  readonly timeoutMs?: number;
}): Promise<"task_passed" | "task_failed"> {
  if (input.oracle.kind === "readonly_unchanged") {
    return checkReadonlyUnchanged(input.oracle.paths, input.workspace, input.stagedFiles);
  }
  if (input.oracle.kind === "architecture_response") {
    return checkArchitectureResponse({
      oracle: input.oracle,
      workspace: input.workspace,
      stagedFiles: input.stagedFiles,
      assistantText: input.assistantText,
    });
  }
  return runTrustedCommandOracle({
    oracle: input.oracle,
    workspace: input.workspace,
    timeoutMs: input.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspaceFile(workspace: string, fixturePath: string): string | undefined {
  const workspaceRoot = resolve(workspace);
  const resolved = resolve(workspaceRoot, fixturePath);
  const pathFromWorkspace = relative(workspaceRoot, resolved);
  if (
    pathFromWorkspace === "" ||
    pathFromWorkspace.startsWith("..") ||
    isAbsolute(pathFromWorkspace)
  ) {
    return undefined;
  }
  return resolved;
}

/**
 * Read candidates must remain ordinary files under the physical workspace root.
 * Checking only the final path component is insufficient: `src/` could itself
 * be a symlink to a model-controlled location outside the workspace.
 */
function resolveRegularWorkspaceFile(workspace: string, fixturePath: string): string | undefined {
  const workspaceRoot = resolve(workspace);
  const source = resolveWorkspaceFile(workspaceRoot, fixturePath);
  if (!source) return undefined;
  try {
    const canonicalWorkspace = realpathSync.native(workspaceRoot);
    const canonicalSource = realpathSync.native(source);
    const pathFromCanonicalWorkspace = relative(canonicalWorkspace, canonicalSource);
    if (
      pathFromCanonicalWorkspace === "" ||
      pathFromCanonicalWorkspace.startsWith("..") ||
      isAbsolute(pathFromCanonicalWorkspace)
    ) {
      return undefined;
    }

    const components = relative(workspaceRoot, source).split(sep);
    let current = workspaceRoot;
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const stat = lstatSync(current);
      if (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
        return undefined;
      }
    }
    return source;
  } catch {
    return undefined;
  }
}

function writeVerifierFile(
  verifierWorkspace: string,
  fixturePath: string,
  content: string,
): boolean {
  const target = resolveWorkspaceFile(verifierWorkspace, fixturePath);
  if (!target) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

function copyRegularSubjectFile(input: {
  readonly workspace: string;
  readonly verifierWorkspace: string;
  readonly fixturePath: string;
}): boolean {
  const source = resolveRegularWorkspaceFile(input.workspace, input.fixturePath);
  if (!source) return false;
  try {
    return writeVerifierFile(
      input.verifierWorkspace,
      input.fixturePath,
      readFileSync(source, "utf8"),
    );
  } catch {
    return false;
  }
}

async function runTrustedCommandOracle(input: {
  readonly oracle: Extract<SelfEvalOracle, { readonly kind: "command" }>;
  readonly workspace: string;
  readonly timeoutMs: number;
}): Promise<"task_passed" | "task_failed"> {
  let verifierWorkspace: string | undefined;
  try {
    verifierWorkspace = mkdtempSync(join(tmpdir(), "brewva-self-eval-verifier-"));
    const verifierTargets = new Set<string>();
    for (const [path, content] of Object.entries(input.oracle.verifierFiles)) {
      const target = resolveWorkspaceFile(verifierWorkspace, path);
      if (!target || verifierTargets.has(target)) return "task_failed";
      verifierTargets.add(target);
      if (!writeVerifierFile(verifierWorkspace, path, content)) return "task_failed";
    }

    const subjectTargets = new Set<string>();
    for (const path of input.oracle.subjectFiles) {
      const target = resolveWorkspaceFile(verifierWorkspace, path);
      // A fixture must not declare a model-produced file as a verifier file.
      // If the two sets overlap, copying the subject after staging the frozen
      // test would silently put model-controlled code back in the verifier.
      if (!target || verifierTargets.has(target) || subjectTargets.has(target)) {
        return "task_failed";
      }
      subjectTargets.add(target);
      if (
        !copyRegularSubjectFile({
          workspace: input.workspace,
          verifierWorkspace,
          fixturePath: path,
        })
      ) {
        return "task_failed";
      }
    }
    return await runCommandOracle(input.oracle.command, verifierWorkspace, input.timeoutMs);
  } catch {
    return "task_failed";
  } finally {
    if (verifierWorkspace) {
      rmSync(verifierWorkspace, { recursive: true, force: true });
    }
  }
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
      const source = resolveRegularWorkspaceFile(workspace, path);
      // A same-content symlink is still a modification of the immutable source
      // contract, and could make the response oracle read ambient files.
      if (!source) return "task_failed";
      current = readFileSync(source, "utf8");
    } catch {
      // The file the task was told NOT to touch is gone — the constraint broke.
      return "task_failed";
    }
    if (current !== staged) return "task_failed";
  }
  return "task_passed";
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((entry) => right.includes(entry))
  );
}

function matchesArchitectureModule(
  actual: Record<string, unknown>,
  expected: SelfEvalArchitectureModuleExpectation,
): boolean {
  if (actual.path !== expected.path) return false;
  const dependsOn = readStringArray(actual.dependsOn);
  if (!dependsOn || !sameStringSet(dependsOn, expected.dependsOn)) return false;
  const responsibility =
    typeof actual.responsibility === "string" ? actual.responsibility.trim() : "";
  if (!responsibility) return false;
  const normalized = responsibility.toLowerCase();
  return expected.responsibilityTerms.some((term) => normalized.includes(term.toLowerCase()));
}

function checkArchitectureResponse(input: {
  readonly oracle: Extract<SelfEvalOracle, { readonly kind: "architecture_response" }>;
  readonly workspace: string;
  readonly stagedFiles: Readonly<Record<string, string>>;
  readonly assistantText?: string;
}): "task_passed" | "task_failed" {
  if (
    checkReadonlyUnchanged(input.oracle.readonlyPaths, input.workspace, input.stagedFiles) !==
    "task_passed"
  ) {
    return "task_failed";
  }
  if (!input.assistantText?.trim()) return "task_failed";

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.assistantText);
  } catch {
    return "task_failed";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.modules) || !parsed.modules.every(isRecord)) {
    return "task_failed";
  }
  const actualByPath = new Map<string, Record<string, unknown>>();
  for (const module of parsed.modules) {
    const path = typeof module.path === "string" ? module.path : undefined;
    if (!path || actualByPath.has(path)) return "task_failed";
    actualByPath.set(path, module);
  }
  if (actualByPath.size !== input.oracle.modules.length) return "task_failed";
  for (const expected of input.oracle.modules) {
    const actual = actualByPath.get(expected.path);
    if (!actual || !matchesArchitectureModule(actual, expected)) return "task_failed";
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
