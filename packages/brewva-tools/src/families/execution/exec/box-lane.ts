import {
  BrewvaBoxScope,
  type BrewvaBoundaryError,
  BrewvaBoundaryFailure,
  BrewvaEffect,
  fromAbortableBoundaryPromise,
  runPromiseAtBoundary,
  withBrewvaObservability,
} from "@brewva/brewva-effect";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import {
  type BoxCapabilitySet,
  type BoxExec,
  type BoxExecResult,
  type BoxHandle,
  type BoxScope,
  type ReleaseReason,
} from "../../../internal/box/index.js";
import { resolveConfiguredBoxPlane } from "../box-plane-runtime.js";
import { startManagedBoxExec } from "../exec-process-registry/api.js";
import { mapHostPathToGuest, type BoxRootMapping } from "./box-root-map.js";
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

export type BoxCommandExecutionError =
  | BrewvaBoundaryError
  | BoxCommandFailedError
  | BoxWorkdirOutsideWorkspaceError
  | ExecAbortedError;

export interface ExecuteBoxCommandInput {
  ownerSessionId: string;
  command: string;
  policy: ResolvedExecutionPolicy;
  runtime?: BrewvaBundledToolRuntime;
  workspaceRoot: string;
  rootMappings: readonly BoxRootMapping[];
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
}

type ExecuteBoxCommandResult = BoxExecutionResult | BoxBackgroundExecutionResult;

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
  rootMappings: readonly BoxRootMapping[];
}): string {
  const requestedCwd = input.requestedCwd ?? input.workspaceRoot;
  const guestCwd = mapHostPathToGuest({
    hostPath: requestedCwd,
    mappings: input.rootMappings,
  });
  if (!guestCwd) {
    throw new BoxWorkdirOutsideWorkspaceError(requestedCwd);
  }
  return guestCwd;
}

function resolveBoxPlane(
  policy: ResolvedExecutionPolicy,
  runtime: BrewvaBundledToolRuntime | undefined,
) {
  return resolveConfiguredBoxPlane(runtime, policy.box);
}

function buildBoxCapabilities(
  policy: ResolvedExecutionPolicy,
  rootMappings: readonly BoxRootMapping[],
): BoxCapabilitySet {
  return {
    network: policy.box.network,
    gpu: false,
    extraVolumes: rootMappings
      .filter((mapping) => !mapping.primary)
      .map((mapping) => ({
        hostPath: mapping.hostPath,
        guestPath: mapping.guestPath,
        readonly: mapping.readonly,
      })),
    secrets: [],
    ports: [],
  };
}

function buildBoxScope(input: {
  ownerSessionId: string;
  policy: ResolvedExecutionPolicy;
  workspaceRoot: string;
  rootMappings: readonly BoxRootMapping[];
}): BoxScope {
  return {
    kind: input.policy.box.scopeDefault,
    id: input.ownerSessionId,
    image: input.policy.box.image,
    workspaceRoot: input.workspaceRoot,
    capabilities: buildBoxCapabilities(input.policy, input.rootMappings),
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

export function executeBoxCommandEffect(
  input: ExecuteBoxCommandInput,
): BrewvaEffect.Effect<ExecuteBoxCommandResult, BoxCommandExecutionError> {
  const observability = {
    sessionId: input.ownerSessionId,
    backend: "box",
  };

  return BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      if (input.signal?.aborted) {
        return yield* BrewvaEffect.fail(new ExecAbortedError());
      }

      const effectiveCwd = yield* BrewvaEffect.try({
        try: () =>
          resolveBoxGuestCwd({
            requestedCwd: input.requestedCwd,
            workspaceRoot: input.workspaceRoot,
            rootMappings: input.rootMappings,
          }),
        catch: (error) =>
          error instanceof BoxWorkdirOutsideWorkspaceError
            ? error
            : new BrewvaBoundaryFailure({
                message: "box.resolveGuestCwd failed",
                cause: error,
              }),
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
        rootMappings: input.rootMappings,
      });
      const bootstrapStartedAt = Date.now();
      input.onBootstrapStarted?.(scope);

      let released = false;
      const releaseBoxOnce = async (box: BoxHandle, reason: ReleaseReason): Promise<void> => {
        if (reason === "detach" || released) {
          return;
        }
        await box.release(reason);
        released = true;
        input.onReleased?.(box, reason);
      };

      const box = yield* BrewvaEffect.acquireRelease(
        fromAbortableBoundaryPromise(async (abortSignal) => {
          input.onBootstrapProgress?.(scope, "acquire");
          try {
            const acquired = await plane.acquire(scope);
            if (abortSignal.aborted) {
              await releaseBoxOnce(
                acquired,
                resolveBoxReleaseReason(acquired, input.policy, input.background),
              );
              throw new ExecAbortedError();
            }
            input.onBootstrapCompleted?.(acquired, Date.now() - bootstrapStartedAt);
            input.onAcquired?.(acquired);
            return acquired;
          } catch (error) {
            if (!(error instanceof ExecAbortedError)) {
              input.onBootstrapFailed?.(scope, error, Date.now() - bootstrapStartedAt);
            }
            throw error;
          }
        }, input.signal),
        (boxHandle) =>
          BrewvaEffect.promise(() =>
            releaseBoxOnce(
              boxHandle,
              resolveBoxReleaseReason(boxHandle, input.policy, input.background),
            ),
          ),
      );

      if (input.snapshotBefore) {
        const snapshot = yield* fromAbortableBoundaryPromise(
          () => box.snapshot(`pre-exec-${Date.now()}`),
          input.signal,
        );
        input.onSnapshot?.(box, snapshot);
      }

      input.onStarted?.(box, effectiveCwd);
      let executionCompleted = false;
      let executionDetached = false;
      const execution = yield* BrewvaEffect.acquireRelease(
        fromAbortableBoundaryPromise(
          () =>
            box.exec({
              argv: [SHELL_COMMAND, ...SHELL_ARGS, boxCommand.shellCommand],
              cwd: effectiveCwd,
              env: boxCommand.env,
              timeoutSec,
              detach: input.background,
            }),
          input.signal,
        ),
        (runningExecution) =>
          BrewvaEffect.promise(async () => {
            if (executionDetached || executionCompleted) {
              return;
            }
            await killBoxExecutionBestEffort(runningExecution);
          }),
      );

      if (input.background) {
        executionDetached = true;
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
              await releaseBoxOnce(box, releaseReason);
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
        } satisfies BoxBackgroundExecutionResult;
      }

      const result = yield* waitForBoxExecutionEffect(execution, input.signal);
      executionCompleted = true;
      const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter((part) => part.length > 0)
        .join("\n");
      if (result.exitCode !== 0) {
        input.onFailed?.(box, { exitCode: result.exitCode });
        const errorText = combined.length > 0 ? combined : "(no output)";
        return yield* BrewvaEffect.fail(
          new BoxCommandFailedError(
            `${errorText}\n\nProcess exited with code ${result.exitCode}.`,
            result.exitCode,
          ),
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
      } satisfies BoxExecutionResult;
    }),
  ).pipe(
    BrewvaEffect.provide(BrewvaBoxScope.layer({ ownerSessionId: input.ownerSessionId })),
    withBrewvaObservability("brewva.tools.box.exec", observability),
  );
}

export async function executeBoxCommand(
  input: ExecuteBoxCommandInput,
): Promise<ExecuteBoxCommandResult> {
  return await runPromiseAtBoundary(executeBoxCommandEffect(input));
}

function killBoxExecutionBestEffort(execution: BoxExec): Promise<void> {
  return execution.kill("SIGKILL").catch(() => undefined);
}

function waitForBoxExecutionEffect(
  execution: BoxExec,
  externalSignal?: AbortSignal,
): BrewvaEffect.Effect<BoxExecResult, BrewvaBoundaryError> {
  return fromAbortableBoundaryPromise(
    async (signal) =>
      await new Promise<BoxExecResult>((resolveWait, rejectWait) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          callback();
        };
        const onAbort = () => {
          void killBoxExecutionBestEffort(execution).finally(() => {
            settle(() => rejectWait(new ExecAbortedError()));
          });
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        execution.wait().then(
          (result) => settle(() => resolveWait(result)),
          (error: unknown) => settle(() => rejectWait(error)),
        );
      }),
    externalSignal,
  );
}
