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
  EXEC_FAILED_EVENT_TYPE,
  EXEC_STARTED_EVENT_TYPE,
  analyzeVirtualReadonlyEligibility,
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  getToolActionPolicy,
  summarizeShellCommandAnalysis,
  summarizeVirtualReadonlyEligibility,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import {
  buildCommandPolicyAuditPayload,
  buildExecAuditPayload,
  buildVirtualReadonlyAuditPayload,
  recordExecEvent,
  redactTextForAudit,
} from "./exec/audit.js";
import {
  BoxCommandFailedError,
  BoxWorkdirOutsideWorkspaceError,
  executeBoxCommand,
} from "./exec/box-lane.js";
import { buildHostEnv, executeHostCommand } from "./exec/host-lane.js";
import {
  DENY_LIST_BEST_EFFORT_MESSAGE,
  resolveExecutionPolicy,
  resolveMisroutedToolName,
  shouldSnapshotBeforeBoxExec,
} from "./exec/policy.js";
import {
  execDisplayResult,
  isExecAbortedError,
  normalizeCommand,
  normalizeOptionalString,
  resolveRequestedEnv,
  resolveTimeoutSec,
  resolveWorkdir,
  resolveWorkspaceRootForCwd,
  resolveYieldMs,
  type ExecToolOptions,
} from "./exec/shared.js";
import {
  executeVirtualReadonlyCommand,
  VirtualReadonlyMaterializationError,
} from "./exec/virtual-readonly-lane.js";
import { resolveToolRuntimeCredentialBindings } from "./runtime-internal.js";
import { isPathInsideRoots, resolveToolTargetScope } from "./target-scope.js";
import { textResult, withVerdict } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

const ExecSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  workdir: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  background: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 7_200_000 })),
});

export function createExecTool(options?: ExecToolOptions): ToolDefinition {
  const execTool = createRuntimeBoundBrewvaToolFactory(options?.runtime, "exec");
  const runtime = execTool.runtime;
  return execTool.define(
    {
      name: "exec",
      label: "Exec",
      description:
        "Execute shell commands with optional background continuation. Pair with process tool for list/poll/log/kill.",
      promptSnippet:
        "Run a bounded shell command when real workspace execution or verification is required.",
      promptGuidelines: [
        "Prefer read-only inspection before mutation or long-running execution.",
        "Use explicit workdir and bounded output for broad commands.",
        "After mutating commands, collect verification evidence before concluding.",
      ],
      parameters: ExecSchema,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const ownerSessionId = getSessionId(ctx);
        const targetScope = resolveToolTargetScope(runtime, ctx);
        const baseCwd = targetScope.baseCwd;
        const command = normalizeCommand(params.command);
        if (!command) {
          return textResult(
            "Exec rejected (missing_command).",
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const requestedWorkdir = normalizeOptionalString(params.workdir);
        const hostCwd = resolveWorkdir(baseCwd, requestedWorkdir);
        if (!isPathInsideRoots(hostCwd, targetScope.allowedRoots)) {
          return textResult(
            `Exec rejected (workdir_outside_target): ${hostCwd}`,
            withVerdict(
              {
                status: "failed",
                reason: "workdir_outside_target",
                requestedCwd: hostCwd,
                allowedRoots: targetScope.allowedRoots,
              },
              "fail",
            ),
          );
        }

        const boxWorkspaceRoot = resolveWorkspaceRootForCwd(hostCwd, targetScope.allowedRoots);
        const boxRequestedCwd = requestedWorkdir ? hostCwd : undefined;
        const boundEnv = resolveToolRuntimeCredentialBindings(runtime, ownerSessionId, "exec");
        const requestedEnv = resolveRequestedEnv({
          userEnv: params.env,
          boundEnv,
        });
        const hostEnv = buildHostEnv(requestedEnv.env);
        const timeoutSec = resolveTimeoutSec(params);
        const background = params.background === true;
        const yieldMs = background ? 0 : resolveYieldMs(params);

        const actionPolicy = getToolActionPolicy(
          "exec",
          undefined,
          params as Record<string, unknown>,
        );
        const policy = resolveExecutionPolicy(runtime, actionPolicy?.boxPolicy);
        const boundaryClassification = classifyToolBoundaryRequest({
          toolName: "exec",
          args: params as Record<string, unknown>,
          cwd: baseCwd,
          workspaceRoot: runtime?.workspaceRoot,
        });
        const primaryTokens = boundaryClassification.detectedCommands;
        const commandPolicy = boundaryClassification.commandPolicy;
        const virtualReadonly = commandPolicy
          ? analyzeVirtualReadonlyEligibility(commandPolicy)
          : undefined;
        const misroutedToolName = resolveMisroutedToolName(primaryTokens);
        if (misroutedToolName) {
          const reason = `Command '${misroutedToolName}' is a Brewva tool name. Call tool '${misroutedToolName}' directly instead of using exec.`;
          recordExecEvent(
            runtime,
            ownerSessionId,
            EXEC_FAILED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                detectedCommands: primaryTokens,
                reason,
                blockedAsToolNameMisroute: true,
                suggestedTool: misroutedToolName,
                ...buildCommandPolicyAuditPayload(commandPolicy),
                ...buildVirtualReadonlyAuditPayload(virtualReadonly),
              },
            }),
          );
          throw new Error(`exec_blocked_isolation: ${reason}`);
        }

        const boundaryDecision = evaluateBoundaryClassification(
          policy.boundaryPolicy,
          boundaryClassification,
        );
        if (!boundaryDecision.allowed) {
          const deniedCommand = primaryTokens.find((token) => policy.commandDenyList.has(token));
          recordExecEvent(
            runtime,
            ownerSessionId,
            EXEC_FAILED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                detectedCommands: primaryTokens,
                deniedCommand,
                requestedCwd: boundaryClassification.requestedCwd ?? null,
                targetHosts: boundaryClassification.targetHosts.map((target) => ({
                  host: target.host,
                  port: target.port,
                })),
                reason: boundaryDecision.reason,
                denyListPolicy: deniedCommand ? DENY_LIST_BEST_EFFORT_MESSAGE : undefined,
                ...buildCommandPolicyAuditPayload(commandPolicy),
                ...buildVirtualReadonlyAuditPayload(virtualReadonly),
              },
            }),
          );
          throw new Error(`exec_blocked_isolation: ${boundaryDecision.reason}`);
        }

        const preferredBackend = policy.backend;
        if (
          preferredBackend === "box" &&
          background &&
          policy.boxPolicy?.kind === "box_required" &&
          policy.boxPolicy.allowDetachedExecution !== true
        ) {
          throw new Error(
            "exec_blocked_isolation: detached execution is not allowed by ToolBoxPolicy for this command.",
          );
        }

        if (
          commandPolicy &&
          virtualReadonly?.eligible &&
          requestedEnv.userRequestedKeys.length === 0 &&
          !background
        ) {
          recordExecEvent(
            runtime,
            ownerSessionId,
            EXEC_STARTED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                resolvedBackend: "virtual_readonly",
                requestedCwd: hostCwd,
                requestedEnvKeys: requestedEnv.userRequestedKeys,
                withheldBoundEnvKeys: requestedEnv.boundEnvKeys,
                droppedEnvKeys: requestedEnv.droppedKeys,
                requestedTimeoutSec: timeoutSec,
                ...buildCommandPolicyAuditPayload(commandPolicy),
                ...buildVirtualReadonlyAuditPayload(virtualReadonly),
              },
            }),
          );
          try {
            return await executeVirtualReadonlyCommand({
              command,
              commandPolicy,
              virtualReadonly,
              cwd: hostCwd,
              timeoutSec,
              signal,
            });
          } catch (error) {
            if (isExecAbortedError(error) || signal?.aborted) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            const auditError = redactTextForAudit(message);
            recordExecEvent(
              runtime,
              ownerSessionId,
              EXEC_FAILED_EVENT_TYPE,
              buildExecAuditPayload({
                toolCallId,
                policy,
                command,
                payload: {
                  reason: "virtual_readonly_execution_error",
                  blockedFeature:
                    error instanceof VirtualReadonlyMaterializationError ? error.code : undefined,
                  error: auditError,
                  ...buildCommandPolicyAuditPayload(commandPolicy),
                  ...buildVirtualReadonlyAuditPayload(virtualReadonly),
                },
              }),
            );
            throw new Error(`exec_blocked_isolation: ${message}`, { cause: error });
          }
        }

        const runHost = async () =>
          executeHostCommand({
            ownerSessionId,
            command,
            cwd: hostCwd,
            env: hostEnv,
            timeoutSec,
            background,
            yieldMs,
            signal,
          });

        if (preferredBackend === "host") {
          recordExecEvent(
            runtime,
            ownerSessionId,
            EXEC_STARTED_EVENT_TYPE,
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                resolvedBackend: preferredBackend,
                requestedCwd: boxRequestedCwd,
                requestedEnvKeys: requestedEnv.requestedKeys,
                appliedEnvKeys: requestedEnv.appliedKeys,
                droppedEnvKeys: requestedEnv.droppedKeys,
                requestedTimeoutSec: timeoutSec,
                ...buildCommandPolicyAuditPayload(commandPolicy),
                ...buildVirtualReadonlyAuditPayload(virtualReadonly),
              },
            }),
          );
          return await runHost();
        }

        try {
          const startedAt = Date.now();
          const result = await executeBoxCommand({
            ownerSessionId,
            command,
            policy,
            runtime,
            workspaceRoot: boxWorkspaceRoot,
            requestedCwd: boxRequestedCwd,
            requestedEnv: requestedEnv.env,
            requestedTimeoutSec: timeoutSec,
            snapshotBefore: shouldSnapshotBeforeBoxExec({
              commandPolicy,
              boxPolicy: policy.boxPolicy,
            }),
            background,
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
          });
          if (result.status === "running") {
            return execDisplayResult(result.output, {
              status: "running",
              verdict: "inconclusive",
              sessionId: result.sessionId,
              boxId: result.boxId,
              executionId: result.executionId,
              fingerprint: result.fingerprint,
              cwd: result.effectiveCwd,
              command,
              backend: "box",
              requestedCwd: result.requestedCwd,
              requestedEnvKeys: result.requestedEnvKeys,
              appliedEnvKeys: result.appliedEnvKeys,
              droppedEnvKeys: result.droppedEnvKeys,
              timeoutSec: result.timeoutSec,
              commandPolicy: commandPolicy
                ? summarizeShellCommandAnalysis(commandPolicy)
                : undefined,
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
              commandPolicy: commandPolicy
                ? summarizeShellCommandAnalysis(commandPolicy)
                : undefined,
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
      },
    },
    {
      requiredCapabilities: [
        "inspect.task.getTargetDescriptor",
        "internal.onClearState",
        "internal.recordEvent",
        "internal.resolveCredentialBindings",
      ],
    },
  );
}
