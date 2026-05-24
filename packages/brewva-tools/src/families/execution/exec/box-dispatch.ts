import {
  BOX_ACQUIRED_EVENT_TYPE,
  BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
  BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
  BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
  BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
  BOX_EXEC_COMPLETED_EVENT_TYPE,
  BOX_EXEC_FAILED_EVENT_TYPE,
  BOX_EXEC_STARTED_EVENT_TYPE,
  BOX_RELEASED_EVENT_TYPE,
  BOX_SNAPSHOT_CREATED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import {
  summarizeShellCommandAnalysis,
  summarizeVirtualReadonlyEligibility,
} from "@brewva/brewva-runtime/security";
import type {
  ShellCommandAnalysis,
  VirtualReadonlyEligibility,
} from "@brewva/brewva-runtime/security";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { resolveManagedExecProcessRegistryRuntime } from "../exec-process-registry/runtime.js";
import {
  buildCommandPolicyAuditPayload,
  buildExecAuditPayload,
  buildVirtualReadonlyAuditPayload,
  recordExecEvent,
  redactTextForAudit,
} from "./audit.js";
import {
  BoxCommandFailedError,
  BoxWorkdirOutsideWorkspaceError,
  executeBoxCommandEffect,
} from "./box-lane.js";
import { serializeBoxRootMappings, type BoxRootMapping } from "./box-root-map.js";
import { type ResolvedExecutionPolicy, shouldSnapshotBeforeBoxExec } from "./policy.js";
import { execDisplayResult, isExecAbortedError, type RequestedEnvResolution } from "./shared.js";

export async function executeBoxCommandWithAudit(input: {
  ownerSessionId: string;
  toolCallId: string;
  command: string;
  policy: ResolvedExecutionPolicy;
  runtime: BrewvaBundledToolRuntime | undefined;
  boxWorkspaceRoot: string;
  boxRootMappings: readonly BoxRootMapping[];
  boxRequestedCwd: string | undefined;
  requestedEnv: RequestedEnvResolution;
  timeoutSec: number | undefined;
  background: boolean;
  yieldMs: number;
  signal: AbortSignal | undefined;
  commandPolicy: ShellCommandAnalysis | undefined;
  virtualReadonly: VirtualReadonlyEligibility | undefined;
  preferredBackend: "box";
}) {
  const {
    ownerSessionId,
    toolCallId,
    command,
    policy,
    runtime,
    boxWorkspaceRoot,
    boxRootMappings,
    boxRequestedCwd,
    requestedEnv,
    timeoutSec,
    background,
    yieldMs,
    signal,
    commandPolicy,
    virtualReadonly,
    preferredBackend,
  } = input;

  try {
    const startedAt = Date.now();
    const registry = resolveManagedExecProcessRegistryRuntime(runtime);
    const result = await registry.runEffect(
      executeBoxCommandEffect({
        ownerSessionId,
        command,
        policy,
        runtime,
        workspaceRoot: boxWorkspaceRoot,
        rootMappings: boxRootMappings,
        requestedCwd: boxRequestedCwd,
        requestedEnv: requestedEnv.env,
        requestedTimeoutSec: timeoutSec,
        snapshotBefore: shouldSnapshotBeforeBoxExec({
          commandPolicy,
          boxPolicy: policy.boxPolicy,
        }),
        background,
        yieldMs,
        signal,
        onBootstrapStarted: (scope) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                scopeKind: scope.kind,
                scopeId: scope.id,
                workspaceRoot: scope.workspaceRoot,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                image: scope.image,
                networkMode: scope.capabilities.network.mode,
              },
            }),
          );
        },
        onBootstrapProgress: (scope, phase) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                scopeKind: scope.kind,
                scopeId: scope.id,
                workspaceRoot: scope.workspaceRoot,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                image: scope.image,
                phase,
              },
            }),
          );
        },
        onBootstrapCompleted: (box, durationMs) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                scopeKind: box.scope.kind,
                scopeId: box.scope.id,
                acquisitionReason: box.acquisitionReason,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                durationMs,
              },
            }),
          );
        },
        onBootstrapFailed: (scope, error, durationMs) => {
          const message = error instanceof Error ? error.message : String(error);
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                scopeKind: scope.kind,
                scopeId: scope.id,
                workspaceRoot: scope.workspaceRoot,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                image: scope.image,
                durationMs,
                reason: "box_bootstrap_failed",
                error: redactTextForAudit(message),
              },
            }),
          );
        },
        onAcquired: (box) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_ACQUIRED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                scopeKind: box.scope.kind,
                scopeId: box.scope.id,
                acquisitionReason: box.acquisitionReason,
                workspaceRoot: box.scope.workspaceRoot,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                image: box.scope.image,
              },
            }),
          );
        },
        onSnapshot: (box, snapshot) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_SNAPSHOT_CREATED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                snapshotId: snapshot.id,
                snapshotName: snapshot.name,
                reason: "snapshot_before_workspace_write",
              },
            }),
          );
        },
        onStarted: (box, effectiveCwd) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_EXEC_STARTED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                resolvedBackend: preferredBackend,
                requestedCwd: boxRequestedCwd,
                effectiveBoxCwd: effectiveCwd,
                rootMappings: serializeBoxRootMappings(boxRootMappings),
                requestedEnvKeys: requestedEnv.requestedKeys,
                appliedEnvKeys: requestedEnv.appliedKeys,
                droppedEnvKeys: requestedEnv.droppedKeys,
                requestedTimeoutSec: timeoutSec,
                ...buildCommandPolicyAuditPayload(commandPolicy),
                ...buildVirtualReadonlyAuditPayload(virtualReadonly),
              },
            }),
          );
        },
        onFailed: (box, failedResult) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_EXEC_FAILED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                exitCode: failedResult.exitCode,
                durationMs: Date.now() - startedAt,
                reason: "box_process_nonzero",
              },
            }),
          );
        },
        onReleased: (box, reason) => {
          recordExecEvent(
            runtime,
            ownerSessionId,
            BOX_RELEASED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                boxId: box.id,
                fingerprint: box.fingerprint,
                scopeKind: box.scope.kind,
                scopeId: box.scope.id,
                reason,
              },
            }),
          );
        },
      }),
    );

    if (result.status === "running") {
      return execDisplayResult(result.output, {
        status: "running",
        verdict: "inconclusive",
        sessionId: result.sessionId,
        pid: result.pid,
        tail: result.tail,
        boxId: result.boxId,
        executionId: result.executionId,
        fingerprint: result.fingerprint,
        cwd: result.effectiveCwd,
        command,
        backend: "box",
        requestedCwd: result.requestedCwd,
        rootMappings: serializeBoxRootMappings(boxRootMappings),
        requestedEnvKeys: result.requestedEnvKeys,
        appliedEnvKeys: result.appliedEnvKeys,
        droppedEnvKeys: result.droppedEnvKeys,
        timeoutSec: result.timeoutSec,
        commandPolicy: commandPolicy ? summarizeShellCommandAnalysis(commandPolicy) : undefined,
        virtualReadonly: virtualReadonly
          ? summarizeVirtualReadonlyEligibility(virtualReadonly)
          : undefined,
      });
    }

    recordExecEvent(
      runtime,
      ownerSessionId,
      BOX_EXEC_COMPLETED_EVENT_TYPE,
      buildExecAuditPayload({
        toolCallId,
        policy,
        command,
        payload: {
          boxId: result.boxId,
          fingerprint: result.fingerprint,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
        },
      }),
    );

    return execDisplayResult(result.output, {
      status: "completed",
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      cwd: result.effectiveCwd,
      command,
      backend: "box",
      requestedCwd: result.requestedCwd,
      rootMappings: serializeBoxRootMappings(boxRootMappings),
      requestedEnvKeys: result.requestedEnvKeys,
      appliedEnvKeys: result.appliedEnvKeys,
      droppedEnvKeys: result.droppedEnvKeys,
      timeoutSec: result.timeoutSec,
      commandPolicy: commandPolicy ? summarizeShellCommandAnalysis(commandPolicy) : undefined,
      virtualReadonly: virtualReadonly
        ? summarizeVirtualReadonlyEligibility(virtualReadonly)
        : undefined,
    });
  } catch (error) {
    if (error instanceof BoxCommandFailedError) {
      throw new Error(error.message, { cause: error });
    }
    if (error instanceof BoxWorkdirOutsideWorkspaceError) {
      return execDisplayResult("Exec rejected (box_workdir_outside_workspace).", {
        status: "failed",
        verdict: "fail",
        reason: "box_workdir_outside_workspace",
        requestedCwd: error.requestedCwd,
        command,
        backend: "box",
        commandPolicy: commandPolicy ? summarizeShellCommandAnalysis(commandPolicy) : undefined,
        virtualReadonly: virtualReadonly
          ? summarizeVirtualReadonlyEligibility(virtualReadonly)
          : undefined,
      });
    }
    if (isExecAbortedError(error) || signal?.aborted) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const auditError = redactTextForAudit(message);
    recordExecEvent(
      runtime,
      ownerSessionId,
      BOX_EXEC_FAILED_EVENT_TYPE,
      buildExecAuditPayload({
        toolCallId,
        policy,
        command,
        payload: {
          reason: "box_execution_error",
          error: auditError,
          ...buildCommandPolicyAuditPayload(commandPolicy),
          ...buildVirtualReadonlyAuditPayload(virtualReadonly),
        },
      }),
    );
    throw new Error(`box_exec_failed: ${message}`, { cause: error });
  }
}
