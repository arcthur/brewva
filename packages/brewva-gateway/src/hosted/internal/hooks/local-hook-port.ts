import type { BrewvaHostContext, InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { BrewvaToolContentPart } from "@brewva/brewva-substrate/tools";
import type { BrewvaStructuredEvent } from "@brewva/brewva-vocabulary/events";
import { SESSION_REWIND_COMPLETED_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import { subscribeRuntimeEvents, type HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import type { TurnLifecyclePort } from "./turn-lifecycle-port.js";

export type LocalHookPhase =
  | "pre_admission"
  | "pre_effect"
  | "post_receipt"
  | "post_rollback"
  | "post_terminal";

export interface LocalHookNote {
  readonly message: string;
  readonly severity?: "info" | "warning" | "error";
}

export interface LocalHookRecommendation {
  readonly message: string;
}

export interface LocalHookPreAdmissionInput {
  readonly phase: "pre_admission";
  readonly sessionId: string;
  readonly prompt: string;
}

export interface LocalHookPreEffectInput {
  readonly phase: "pre_effect";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface LocalHookPostReceiptInput {
  readonly phase: "post_receipt";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly BrewvaToolContentPart[];
  readonly isError: boolean;
  readonly details?: unknown;
}

export interface LocalHookPostRollbackInput {
  readonly phase: "post_rollback";
  readonly sessionId: string;
  readonly reason?: string;
}

export interface LocalHookPostTerminalInput {
  readonly phase: "post_terminal";
  readonly sessionId: string;
}

export type LocalHookResult =
  | { readonly kind: "observe"; readonly notes?: readonly LocalHookNote[] }
  | {
      readonly kind: "recommend";
      readonly recommendations: readonly LocalHookRecommendation[];
      readonly notes?: readonly LocalHookNote[];
    };

export type LocalHookPreAdmissionResult = LocalHookResult | undefined;
export type LocalHookPreEffectResult = LocalHookResult | undefined;
export type LocalHookPostReceiptResult = LocalHookResult | undefined;
export type LocalHookPostRollbackResult = LocalHookResult | undefined;
export type LocalHookPostTerminalResult = LocalHookResult | undefined;

export interface LocalHookPort {
  readonly name: string;
  preAdmission?(
    input: LocalHookPreAdmissionInput,
  ): Promise<LocalHookPreAdmissionResult> | LocalHookPreAdmissionResult;
  preEffect?(
    input: LocalHookPreEffectInput,
  ): Promise<LocalHookPreEffectResult> | LocalHookPreEffectResult;
  postReceipt?(
    input: LocalHookPostReceiptInput,
  ): Promise<LocalHookPostReceiptResult> | LocalHookPostReceiptResult;
  postRollback?(
    input: LocalHookPostRollbackInput,
  ): Promise<LocalHookPostRollbackResult> | LocalHookPostRollbackResult;
  postTerminal?(
    input: LocalHookPostTerminalInput,
  ): Promise<LocalHookPostTerminalResult> | LocalHookPostTerminalResult;
}

export interface LocalHookManager {
  readonly lifecycle: TurnLifecyclePort;
  clear(sessionId: string): void;
  dispose(): void;
}

const POST_ROLLBACK_EVENT_TYPES = new Set<string>([
  ROLLBACK_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
]);

function getSessionId(ctx: BrewvaHostContext): string {
  return ctx.sessionManager.getSessionId();
}

function cloneToolContentParts(content: readonly BrewvaToolContentPart[]): BrewvaToolContentPart[] {
  return content.map((part) => ({ ...part }));
}

function cloneHookDetails(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return {
      unavailable: true,
      reason: "uncloneable_tool_result_details",
    };
  }
}

function recordGovernanceDecision(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  phase: LocalHookPhase;
  hookName: string;
  result: LocalHookResult;
}): void {
  input.runtime.ops.proposals.governance.turnDecisionRecorded({
    sessionId: input.sessionId,
    payload: {
      schema: "brewva.turn_governance_decision.v1",
      source: "local_hook",
      phase: input.phase,
      hookName: input.hookName,
      result: input.result,
    },
  });
}

function readRollbackReason(event: BrewvaStructuredEvent): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : undefined;
}

function describeHookError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unknown local hook error.";
}

function isLocalHookResult(result: unknown): result is LocalHookResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const kind = (result as { kind?: unknown }).kind;
  return kind === "observe" || kind === "recommend";
}

function normalizeAdvisoryHookResult(
  phase: LocalHookPhase,
  result: unknown,
): LocalHookResult | undefined {
  if (!result) {
    return undefined;
  }
  if (isLocalHookResult(result)) {
    return result;
  }
  return {
    kind: "observe",
    notes: [
      {
        severity: "warning",
        message: `${phase} hook returned an invalid advisory result; ignored by the local hook manager.`,
      },
    ],
  };
}

function resolvePreAdmissionHook(hook: LocalHookPort): LocalHookPort["preAdmission"] | undefined {
  return hook.preAdmission?.bind(hook);
}

function resolvePreEffectHook(hook: LocalHookPort): LocalHookPort["preEffect"] | undefined {
  return hook.preEffect?.bind(hook);
}

function resolvePostReceiptHook(hook: LocalHookPort): LocalHookPort["postReceipt"] | undefined {
  return hook.postReceipt?.bind(hook);
}

function resolvePostTerminalHook(hook: LocalHookPort): LocalHookPort["postTerminal"] | undefined {
  return hook.postTerminal?.bind(hook);
}

export function createLocalHookManager(input: {
  extensionApi: InternalHostPluginApi;
  runtime: HostedRuntimeAdapterPort;
  hooks: readonly LocalHookPort[];
}): LocalHookManager {
  const activeSessions = new Set<string>();
  let unsubscribePostRollbackEvents: (() => void) | undefined;

  function disposePostRollbackSubscription(): void {
    unsubscribePostRollbackEvents?.();
    unsubscribePostRollbackEvents = undefined;
  }

  function ensurePostRollbackSubscription(): void {
    unsubscribePostRollbackEvents ??= subscribeRuntimeEvents(input.runtime, (event) => {
      if (!POST_ROLLBACK_EVENT_TYPES.has(event.type)) {
        return;
      }
      void runPostRollbackHooks(event);
    });
  }

  async function runPostRollbackHooks(event: BrewvaStructuredEvent): Promise<void> {
    for (const hook of input.hooks) {
      if (!hook.postRollback) {
        continue;
      }
      let result: LocalHookResult | undefined;
      try {
        result = normalizeAdvisoryHookResult(
          "post_rollback",
          await hook.postRollback({
            phase: "post_rollback",
            sessionId: event.sessionId,
            reason: readRollbackReason(event),
          }),
        );
      } catch (error) {
        recordGovernanceDecision({
          runtime: input.runtime,
          sessionId: event.sessionId,
          phase: "post_rollback",
          hookName: hook.name,
          result: {
            kind: "observe",
            notes: [
              {
                severity: "error",
                message: `post_rollback hook failed: ${describeHookError(error)}`,
              },
            ],
          },
        });
        continue;
      }
      if (result) {
        recordGovernanceDecision({
          runtime: input.runtime,
          sessionId: event.sessionId,
          phase: "post_rollback",
          hookName: hook.name,
          result,
        });
      }
    }
  }

  ensurePostRollbackSubscription();

  input.extensionApi.on("tool_call", async (event, ctx): Promise<undefined> => {
    const sessionId = getSessionId(ctx);
    for (const hook of input.hooks) {
      const preEffect = resolvePreEffectHook(hook);
      if (!preEffect) {
        continue;
      }
      const result = normalizeAdvisoryHookResult(
        "pre_effect",
        await preEffect({
          phase: "pre_effect",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }),
      );
      if (!result) {
        continue;
      }
      recordGovernanceDecision({
        runtime: input.runtime,
        sessionId,
        phase: "pre_effect",
        hookName: hook.name,
        result,
      });
    }
    return undefined;
  });

  input.extensionApi.on("tool_result", async (event, ctx): Promise<undefined> => {
    const sessionId = getSessionId(ctx);
    for (const hook of input.hooks) {
      const postReceipt = resolvePostReceiptHook(hook);
      if (!postReceipt) {
        continue;
      }
      const result = await postReceipt({
        phase: "post_receipt",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        content: cloneToolContentParts(event.content),
        isError: event.isError,
        ...(event.details !== undefined ? { details: cloneHookDetails(event.details) } : {}),
      });
      const normalized = normalizeAdvisoryHookResult("post_receipt", result);
      if (normalized) {
        recordGovernanceDecision({
          runtime: input.runtime,
          sessionId,
          phase: "post_receipt",
          hookName: hook.name,
          result: normalized,
        });
      }
    }
    return undefined;
  });

  return {
    lifecycle: {
      async beforeAgentStart(event, ctx) {
        const sessionId = getSessionId(ctx);
        activeSessions.add(sessionId);
        ensurePostRollbackSubscription();
        const prompt = event.prompt;
        for (const hook of input.hooks) {
          const preAdmission = resolvePreAdmissionHook(hook);
          if (!preAdmission) {
            continue;
          }
          const result = normalizeAdvisoryHookResult(
            "pre_admission",
            await preAdmission({
              phase: "pre_admission",
              sessionId,
              prompt,
            }),
          );
          if (!result) {
            continue;
          }
          recordGovernanceDecision({
            runtime: input.runtime,
            sessionId,
            phase: "pre_admission",
            hookName: hook.name,
            result,
          });
        }
        return undefined;
      },
      async turnEnd(_event, ctx) {
        const sessionId = getSessionId(ctx);
        for (const hook of input.hooks) {
          const postTerminal = resolvePostTerminalHook(hook);
          if (!postTerminal) {
            continue;
          }
          const result = normalizeAdvisoryHookResult(
            "post_terminal",
            await postTerminal({
              phase: "post_terminal",
              sessionId,
            }),
          );
          if (result) {
            recordGovernanceDecision({
              runtime: input.runtime,
              sessionId,
              phase: "post_terminal",
              hookName: hook.name,
              result,
            });
          }
        }
        return undefined;
      },
      sessionShutdown(_event, ctx) {
        const sessionId = getSessionId(ctx);
        activeSessions.delete(sessionId);
        if (activeSessions.size === 0) {
          disposePostRollbackSubscription();
        }
        return undefined;
      },
    },
    clear(sessionId) {
      activeSessions.delete(sessionId);
      if (activeSessions.size === 0) {
        disposePostRollbackSubscription();
      }
    },
    dispose() {
      activeSessions.clear();
      disposePostRollbackSubscription();
    },
  };
}
