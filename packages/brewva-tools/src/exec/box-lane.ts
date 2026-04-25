import { posix, relative, resolve } from "node:path";
import {
  type BoxCapabilitySet,
  type BoxHandle,
  type BoxScope,
  type ReleaseReason,
} from "@brewva/brewva-box";
import { resolveConfiguredBoxPlane } from "../box-plane-runtime.js";
import { startManagedBoxExec } from "../exec-process-registry.js";
import type { BrewvaBundledToolRuntime } from "../types.js";
import type { ResolvedExecutionPolicy } from "./policy.js";
import {
  ExecAbortedError,
  isSafeEnvKey,
  SHELL_ARGS,
  SHELL_COMMAND,
  VALID_ENV_KEY,
} from "./shared.js";

export interface BoxCommandBuildResult {
  shellCommand: string;
  requestedCwd?: string;
  effectiveCwd?: string;
  requestedEnvKeys: string[];
  appliedEnvKeys: string[];
  droppedEnvKeys: string[];
  env?: Record<string, string>;
}

export interface BoxExecutionResult {
  status: "completed";
  output: string;
  exitCode: number;
  boxId?: string;
  fingerprint?: string;
  requestedCwd?: string;
  effectiveCwd: string;
  requestedEnvKeys: string[];
  appliedEnvKeys: string[];
  droppedEnvKeys: string[];
  timeoutSec: number;
}

export interface BoxBackgroundExecutionResult {
  status: "running";
  output: string;
  sessionId: string;
  boxId: string;
  executionId: string;
  fingerprint?: string;
  requestedCwd?: string;
  effectiveCwd: string;
  requestedEnvKeys: string[];
  appliedEnvKeys: string[];
  droppedEnvKeys: string[];
  timeoutSec: number;
}

export class BoxCommandFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "BoxCommandFailedError";
    this.exitCode = exitCode;
  }
}

export class BoxWorkdirOutsideWorkspaceError extends Error {
  constructor(readonly requestedCwd: string) {
    super(`box workdir is outside workspaceRoot: ${requestedCwd}`);
    this.name = "BoxWorkdirOutsideWorkspaceError";
  }
}

function buildBoxCommand(input: {
  command: string;
  requestedCwd?: string;
  effectiveCwd: string;
  requestedEnv?: Record<string, string>;
}): BoxCommandBuildResult {
  const requestedEnvEntries = Object.entries(input.requestedEnv ?? {});
  const requestedEnvKeys = requestedEnvEntries.map(([key]) => key);
  const appliedEnvEntries = requestedEnvEntries.filter(([key]) => isSafeEnvKey(key));
  const appliedEnvKeys = appliedEnvEntries.map(([key]) => key);
  const appliedEnv = Object.fromEntries(appliedEnvEntries) as Record<string, string>;
  const droppedEnvKeys = requestedEnvEntries
    .map(([key]) => key)
    .filter((key) => !VALID_ENV_KEY.test(key));

  return {
    shellCommand: input.command,
    requestedCwd: input.requestedCwd,
    effectiveCwd: input.effectiveCwd,
    requestedEnvKeys,
    appliedEnvKeys,
    droppedEnvKeys,
    env: appliedEnvKeys.length > 0 ? appliedEnv : undefined,
  };
}

function resolveBoxGuestCwd(input: {
  requestedCwd?: string;
  workspaceRoot: string;
  workspaceGuestPath: string;
}): string {
  if (!input.requestedCwd) return input.workspaceGuestPath;
  const relativeCwd = relative(resolve(input.workspaceRoot), resolve(input.requestedCwd));
  if (relativeCwd === "") return input.workspaceGuestPath;
  if (relativeCwd.startsWith("..") || relativeCwd.startsWith("/")) {
    throw new BoxWorkdirOutsideWorkspaceError(input.requestedCwd);
  }
  return posix.join(input.workspaceGuestPath, ...relativeCwd.split(/[\\/]+/u));
}

function resolveBoxPlane(
  policy: ResolvedExecutionPolicy,
  runtime: BrewvaBundledToolRuntime | undefined,
) {
  return resolveConfiguredBoxPlane(runtime, policy.box);
}

function buildBoxCapabilities(policy: ResolvedExecutionPolicy): BoxCapabilitySet {
  return {
    network: policy.box.network,
    gpu: false,
    extraVolumes: [],
    secrets: [],
    ports: [],
  };
}

function buildBoxScope(input: {
  ownerSessionId: string;
  policy: ResolvedExecutionPolicy;
  workspaceRoot: string;
}): BoxScope {
  return {
    kind: input.policy.box.scopeDefault,
    id: input.ownerSessionId,
    image: input.policy.box.image,
    workspaceRoot: input.workspaceRoot,
    capabilities: buildBoxCapabilities(input.policy),
  };
}

function resolveBoxReleaseReason(
  box: BoxHandle,
  policy: ResolvedExecutionPolicy,
  background: boolean,
): ReleaseReason {
  if (background) return "detach";
  if (box.scope.kind === "ephemeral") return "ephemeral_done";
  return policy.box.detach ? "detach" : "task_completed";
}

function resolveBoxCompletionReleaseReason(
  box: BoxHandle,
  policy: ResolvedExecutionPolicy,
): ReleaseReason | undefined {
  const releaseReason = resolveBoxReleaseReason(box, policy, false);
  return releaseReason === "detach" ? undefined : releaseReason;
}

export async function executeBoxCommand(input: {
  ownerSessionId: string;
  command: string;
  policy: ResolvedExecutionPolicy;
  runtime?: BrewvaBundledToolRuntime;
  workspaceRoot: string;
  requestedCwd?: string;
  requestedEnv?: Record<string, string>;
  requestedTimeoutSec?: number;
  snapshotBefore: boolean;
  background: boolean;
  signal?: AbortSignal;
  onBootstrapStarted?(scope: BoxScope): void;
  onBootstrapProgress?(scope: BoxScope, phase: string): void;
  onBootstrapCompleted?(box: BoxHandle, durationMs: number): void;
  onBootstrapFailed?(scope: BoxScope, error: unknown, durationMs: number): void;
  onAcquired?(box: BoxHandle): void;
  onSnapshot?(box: BoxHandle, snapshot: { id: string; name: string; boxId: string }): void;
  onStarted?(box: BoxHandle, effectiveCwd: string): void;
  onFailed?(box: BoxHandle, result: { exitCode: number }): void;
  onReleased?(box: BoxHandle, reason: ReleaseReason): void;
}): Promise<BoxExecutionResult | BoxBackgroundExecutionResult> {
  if (input.signal?.aborted) {
    throw new ExecAbortedError();
  }

  const effectiveCwd = resolveBoxGuestCwd({
    requestedCwd: input.requestedCwd,
    workspaceRoot: input.workspaceRoot,
    workspaceGuestPath: input.policy.box.workspaceGuestPath,
  });
  const boxCommand = buildBoxCommand({
    command: input.command,
    requestedCwd: input.requestedCwd,
    effectiveCwd,
    requestedEnv: input.requestedEnv,
  });
  const timeoutSec = input.requestedTimeoutSec ?? 180;
  const plane = resolveBoxPlane(input.policy, input.runtime);
  const scope = buildBoxScope({
    ownerSessionId: input.ownerSessionId,
    policy: input.policy,
    workspaceRoot: input.workspaceRoot,
  });
  const bootstrapStartedAt = Date.now();
  input.onBootstrapStarted?.(scope);
  input.onBootstrapProgress?.(scope, "acquire");
  let box: BoxHandle | undefined;
  try {
    box = await plane.acquire(scope);
  } catch (error) {
    input.onBootstrapFailed?.(scope, error, Date.now() - bootstrapStartedAt);
    throw error;
  }
  input.onBootstrapCompleted?.(box, Date.now() - bootstrapStartedAt);
  input.onAcquired?.(box);

  try {
    if (input.snapshotBefore) {
      const snapshot = await box.snapshot(`pre-exec-${Date.now()}`);
      input.onSnapshot?.(box, snapshot);
    }

    input.onStarted?.(box, effectiveCwd);
    const execution = await box.exec({
      argv: [SHELL_COMMAND, ...SHELL_ARGS, boxCommand.shellCommand],
      cwd: effectiveCwd,
      env: boxCommand.env,
      timeoutSec,
      detach: input.background,
    });
    if (input.background) {
      const started = startManagedBoxExec({
        ownerSessionId: input.ownerSessionId,
        command: input.command,
        cwd: effectiveCwd,
        boxId: box.id,
        fingerprint: box.fingerprint,
        execution,
        plane,
        timeoutSec,
        releaseOnCompletion: (() => {
          const releaseReason = resolveBoxCompletionReleaseReason(box, input.policy);
          if (!releaseReason) return undefined;
          return async () => {
            await box.release(releaseReason);
            input.onReleased?.(box, releaseReason);
          };
        })(),
      });
      return {
        status: "running",
        output: `Command still running (session ${started.session.id}, box ${box.id}, execution ${execution.id}).\nUse process (list/poll/log/kill/clear/remove) for follow-up.`,
        sessionId: started.session.id,
        boxId: box.id,
        executionId: execution.id,
        fingerprint: box.fingerprint,
        requestedCwd: boxCommand.requestedCwd,
        effectiveCwd,
        requestedEnvKeys: boxCommand.requestedEnvKeys,
        appliedEnvKeys: boxCommand.appliedEnvKeys,
        droppedEnvKeys: boxCommand.droppedEnvKeys,
        timeoutSec,
      };
    }
    const result = await execution.wait();
    const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()]
      .filter((part) => part.length > 0)
      .join("\n");
    if (result.exitCode !== 0) {
      input.onFailed?.(box, { exitCode: result.exitCode });
      const errorText = combined.length > 0 ? combined : "(no output)";
      throw new BoxCommandFailedError(
        `${errorText}\n\nProcess exited with code ${result.exitCode}.`,
        result.exitCode,
      );
    }
    return {
      status: "completed",
      output: combined.length > 0 ? combined : "(no output)",
      exitCode: result.exitCode,
      boxId: box.id,
      fingerprint: box.fingerprint,
      requestedCwd: boxCommand.requestedCwd,
      effectiveCwd,
      requestedEnvKeys: boxCommand.requestedEnvKeys,
      appliedEnvKeys: boxCommand.appliedEnvKeys,
      droppedEnvKeys: boxCommand.droppedEnvKeys,
      timeoutSec,
    };
  } finally {
    const releaseReason = resolveBoxReleaseReason(box, input.policy, input.background);
    if (releaseReason !== "detach") {
      await box.release(releaseReason);
      input.onReleased?.(box, releaseReason);
    }
  }
}
