import { relative, resolve } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { classifyCommandClass } from "@brewva/brewva-std/command-class";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { textResultForOutcome, type ToolTextOutcomeKind } from "../../../utils/result.js";

export const DEFAULT_YIELD_MS = 10_000;
/**
 * Default foreground wait for verification-class commands (builds, tests,
 * linters) when the config carries no value. Matches the yieldMs clamp so a
 * typical verification run finishes in one exec call rather than a
 * background + poll loop.
 */
export const DEFAULT_VERIFICATION_FOREGROUND_WAIT_MS = 120_000;
export const MAX_TIMEOUT_SEC = 7_200;
export const MAX_TIMEOUT_MS = MAX_TIMEOUT_SEC * 1_000;
export const SHELL_COMMAND = "sh";
export const SHELL_ARGS = ["-c"];
export const DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH = 240;
export const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type SecurityMode = BrewvaConfig["security"]["mode"];
export type ExecutionBackend = BrewvaConfig["security"]["execution"]["backend"];
export type BoxConfig = BrewvaConfig["security"]["execution"]["box"];
export type ExecutionAutoBackgroundConfig = BrewvaConfig["security"]["execution"]["autoBackground"];

export interface ExecToolOptions {
  runtime?: import("../../../contracts/index.js").BrewvaBundledToolRuntime;
}

export interface RequestedEnvResolution {
  env?: Record<string, string>;
  requestedKeys: string[];
  userRequestedKeys: string[];
  boundEnvKeys: string[];
  appliedKeys: string[];
  droppedKeys: string[];
}

export class ExecAbortedError extends Error {
  constructor() {
    super("Execution aborted by signal.");
    this.name = "ExecAbortedError";
  }
}

export class ExecCommandFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ExecCommandFailedError";
    this.exitCode = exitCode;
  }
}

export function isExecAbortedError(error: unknown): error is ExecAbortedError {
  return error instanceof ExecAbortedError;
}

export function normalizeCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value.trim();
  return command.length > 0 ? command : undefined;
}

export function resolveWorkdir(baseCwd: string, value: unknown): string {
  if (typeof value !== "string") return baseCwd;
  const trimmed = value.trim();
  if (!trimmed) return baseCwd;
  return resolve(baseCwd, trimmed);
}

export function resolveYieldMs(
  params: { yieldMs?: unknown },
  defaultYieldMs = DEFAULT_YIELD_MS,
): number {
  const raw = params.yieldMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return defaultYieldMs;
  return Math.max(0, Math.min(120_000, Math.trunc(raw)));
}

export function resolveForegroundWaitMs(config: ExecutionAutoBackgroundConfig | undefined): number {
  const raw = config?.foregroundWaitMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_YIELD_MS;
  return Math.max(1, Math.min(120_000, Math.trunc(raw)));
}

/**
 * Operator policy for how long verification-class commands may block the
 * turn. A distinct knob from foregroundWaitMs so tuning general snappiness
 * down does not silently truncate builds — and vice versa.
 */
export function resolveVerificationForegroundWaitMs(
  config: ExecutionAutoBackgroundConfig | undefined,
): number {
  const raw = config?.verificationForegroundWaitMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_VERIFICATION_FOREGROUND_WAIT_MS;
  }
  return Math.max(1, Math.min(120_000, Math.trunc(raw)));
}

/**
 * The foreground wait (yieldMs) an exec call blocks for before it backgrounds.
 * `background: true` yields immediately (0). Otherwise the model's explicit
 * yieldMs wins for a general command; for a verification-class command the
 * operator-configured wait is a FLOOR — an explicit value may RAISE it but must
 * not silently truncate the build below the configured wait (a low value would
 * collapse P3 into a background + activity-poll loop). Pure and deterministic so
 * the pacing decision is unit-testable in isolation from the exec effect.
 */
export function resolveExecForegroundYieldMs(input: {
  command: string;
  background: boolean;
  params: { yieldMs?: unknown };
  autoBackground: ExecutionAutoBackgroundConfig | undefined;
}): number {
  if (input.background) {
    return 0;
  }
  const isVerification = classifyCommandClass(input.command) === "verification";
  const defaultYieldMs = isVerification
    ? resolveVerificationForegroundWaitMs(input.autoBackground)
    : resolveForegroundWaitMs(input.autoBackground);
  const resolved = resolveYieldMs(input.params, defaultYieldMs);
  return isVerification ? Math.max(resolved, defaultYieldMs) : resolved;
}

/**
 * Follow-up guidance for a command that backgrounded despite its foreground
 * wait. A verification-class command (build/test/lint/typecheck) that still ran
 * long should be polled with `until=exit` so the model blocks for the exit
 * verdict in ONE call instead of churning `until="activity"` polls; every other
 * command gets the generic process surface. The command is re-classified from
 * the same static table the pacing decision used — no new state to thread.
 */
export function backgroundFollowUpLine(command: string, genericFollowUp: string): string {
  return classifyCommandClass(command) === "verification"
    ? "Verification command still running — poll with `process poll until=exit` to block for the exit verdict in one call (avoids an activity-poll loop)."
    : genericFollowUp;
}

export function resolveTimeoutSec(params: { timeout?: unknown }): number | undefined {
  const clampSeconds = (seconds: number): number => Math.max(1, Math.min(MAX_TIMEOUT_SEC, seconds));

  const timeout = params.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    return undefined;
  }

  // Values above 1000 are treated as milliseconds. Smaller values remain seconds.
  if (timeout > 1_000) {
    const normalizedMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, timeout));
    return clampSeconds(normalizedMs / 1_000);
  }

  return clampSeconds(timeout);
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isSafeEnvKey(key: string): boolean {
  return VALID_ENV_KEY.test(key) && !DANGEROUS_OBJECT_KEYS.has(key);
}

export function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

export function resolveRequestedEnv(input: {
  userEnv?: Record<string, string>;
  boundEnv: Record<string, string>;
}): RequestedEnvResolution {
  const env = Object.create(null) as Record<string, string>;
  const requestedKeys: string[] = [];
  const userRequestedKeys: string[] = [];
  const boundEnvKeys: string[] = [];
  const appliedKeys: string[] = [];
  const droppedKeys: string[] = [];

  const applyEntries = (entries: Iterable<[string, unknown]>, source: "user" | "bound") => {
    for (const [key, value] of entries) {
      requestedKeys.push(key);
      if (source === "user") {
        userRequestedKeys.push(key);
      } else {
        boundEnvKeys.push(key);
      }
      if (!isSafeEnvKey(key) || typeof value !== "string") {
        droppedKeys.push(key);
        continue;
      }
      env[key] = value;
      appliedKeys.push(key);
    }
  };

  applyEntries(Object.entries(input.userEnv ?? {}), "user");
  applyEntries(Object.entries(input.boundEnv), "bound");

  const uniqueAppliedKeys = uniqueKeys(appliedKeys);
  return {
    env: uniqueAppliedKeys.length > 0 ? env : undefined,
    requestedKeys: uniqueKeys(requestedKeys),
    userRequestedKeys: uniqueKeys(userRequestedKeys),
    boundEnvKeys: uniqueKeys(boundEnvKeys),
    appliedKeys: uniqueAppliedKeys,
    droppedKeys: uniqueKeys(droppedKeys),
  };
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function resolveWorkspaceRootForCwd(cwd: string, allowedRoots: readonly string[]): string {
  const matches = allowedRoots
    .map((root) => resolve(root))
    .filter((root) => isPathInsideRoot(cwd, root))
    .toSorted((left, right) => right.length - left.length);
  return matches[0] ?? resolve(cwd);
}

export function execDisplayResult(
  text: string,
  payload: Record<string, unknown>,
  outcomeKind: ToolTextOutcomeKind = "ok",
) {
  return textResultForOutcome(outcomeKind, text, payload, {
    detailsText: text,
    rawText: text,
  });
}

export function hashText(value: string): string {
  return sha256Hex(value);
}
