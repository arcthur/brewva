import {
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  TURN_GOVERNANCE_DECISION_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
  type BrewvaStructuredEvent,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type {
  BrewvaHostContext,
  BrewvaHostToolCallResult,
  BrewvaToolContentPart,
  InternalHostPluginApi,
} from "@brewva/brewva-substrate";
import type { SkillClassificationHint } from "./skill-first.js";
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
  readonly classificationHint?: SkillClassificationHint;
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
    }
  | {
      readonly kind: "block_tool";
      readonly reason: string;
      readonly notes?: readonly LocalHookNote[];
    };

export type LocalHookPreAdmissionResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;
export type LocalHookPreEffectResult = LocalHookResult | undefined;
export type LocalHookPostReceiptResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;
export type LocalHookPostRollbackResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;
export type LocalHookPostTerminalResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;

export type LocalHookPreClassifyInput = LocalHookPreAdmissionInput;
export type LocalHookPreClassifyResult = LocalHookPreAdmissionResult;
export type LocalHookPreToolInput = LocalHookPreEffectInput;
export type LocalHookPreToolResult = LocalHookPreEffectResult;
export type LocalHookPostToolInput = LocalHookPostReceiptInput;
export type LocalHookPostToolResult = LocalHookPostReceiptResult;
export type LocalHookEndTurnInput = LocalHookPostTerminalInput;
export type LocalHookEndTurnResult = LocalHookPostTerminalResult;

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
  /** @deprecated Use preAdmission. */
  preClassify?(
    input: LocalHookPreClassifyInput,
  ): Promise<LocalHookPreClassifyResult> | LocalHookPreClassifyResult;
  /** @deprecated Use preEffect. */
  preTool?(input: LocalHookPreToolInput): Promise<LocalHookPreToolResult> | LocalHookPreToolResult;
  /** @deprecated Use postReceipt. */
  postTool?(
    input: LocalHookPostToolInput,
  ): Promise<LocalHookPostToolResult> | LocalHookPostToolResult;
  /** @deprecated Use postTerminal. */
  endTurn?(input: LocalHookEndTurnInput): Promise<LocalHookEndTurnResult> | LocalHookEndTurnResult;
}

export interface LocalHookManager {
  readonly lifecycle: TurnLifecyclePort;
  getClassificationHints(sessionId: string): readonly SkillClassificationHint[];
  clear(sessionId: string): void;
  dispose(): void;
}

type NonBlockingLocalHookPhase = Exclude<LocalHookPhase, "pre_effect">;
type NonBlockingLocalHookResult =
  | Extract<LocalHookResult, { readonly kind: "observe" | "recommend" }>
  | undefined;

const POST_ROLLBACK_EVENT_TYPES = new Set<string>([
  ROLLBACK_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
]);

const LEGACY_HOOK_ALIAS_WARNINGS = new Set<string>();

function getSessionId(ctx: BrewvaHostContext): string {
  return ctx.sessionManager.getSessionId();
}

function extractClassificationHints(
  recommendations: readonly LocalHookRecommendation[] | undefined,
): SkillClassificationHint[] {
  return (recommendations ?? [])
    .map((entry) => entry.classificationHint)
    .filter((entry): entry is SkillClassificationHint => Boolean(entry));
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
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  phase: LocalHookPhase;
  hookName: string;
  result: LocalHookResult;
}): void {
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TURN_GOVERNANCE_DECISION_EVENT_TYPE,
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

function normalizeNonBlockingHookResult(
  phase: NonBlockingLocalHookPhase,
  result: LocalHookResult | undefined,
): NonBlockingLocalHookResult {
  if (!result) {
    return undefined;
  }
  if (result.kind !== "block_tool") {
    return result;
  }
  return {
    kind: "observe",
    notes: [
      ...(result.notes ?? []),
      {
        severity: "warning",
        message: `${phase} hook returned block_tool; only pre_effect hooks may block tool execution.`,
      },
      {
        severity: "warning",
        message: `Ignored block reason: ${result.reason}`,
      },
    ],
  };
}

function warnLegacyHookAlias(input: {
  hookName: string;
  legacyName: string;
  canonicalName: string;
}): void {
  const key = `${input.hookName}:${input.legacyName}`;
  if (LEGACY_HOOK_ALIAS_WARNINGS.has(key)) {
    return;
  }
  LEGACY_HOOK_ALIAS_WARNINGS.add(key);
  console.warn(
    `Local hook '${input.hookName}' uses deprecated ${input.legacyName}; use ${input.canonicalName}.`,
  );
}

function resolvePreAdmissionHook(hook: LocalHookPort): LocalHookPort["preAdmission"] | undefined {
  if (hook.preAdmission) {
    return hook.preAdmission.bind(hook);
  }
  if (!hook.preClassify) {
    return undefined;
  }
  warnLegacyHookAlias({
    hookName: hook.name,
    legacyName: "preClassify",
    canonicalName: "preAdmission",
  });
  return hook.preClassify.bind(hook);
}

function resolvePreEffectHook(hook: LocalHookPort): LocalHookPort["preEffect"] | undefined {
  if (hook.preEffect) {
    return hook.preEffect.bind(hook);
  }
  if (!hook.preTool) {
    return undefined;
  }
  warnLegacyHookAlias({
    hookName: hook.name,
    legacyName: "preTool",
    canonicalName: "preEffect",
  });
  return hook.preTool.bind(hook);
}

function resolvePostReceiptHook(hook: LocalHookPort): LocalHookPort["postReceipt"] | undefined {
  if (hook.postReceipt) {
    return hook.postReceipt.bind(hook);
  }
  if (!hook.postTool) {
    return undefined;
  }
  warnLegacyHookAlias({
    hookName: hook.name,
    legacyName: "postTool",
    canonicalName: "postReceipt",
  });
  return hook.postTool.bind(hook);
}

function resolvePostTerminalHook(hook: LocalHookPort): LocalHookPort["postTerminal"] | undefined {
  if (hook.postTerminal) {
    return hook.postTerminal.bind(hook);
  }
  if (!hook.endTurn) {
    return undefined;
  }
  warnLegacyHookAlias({
    hookName: hook.name,
    legacyName: "endTurn",
    canonicalName: "postTerminal",
  });
  return hook.endTurn.bind(hook);
}

export function createLocalHookManager(input: {
  extensionApi: InternalHostPluginApi;
  runtime: BrewvaHostedRuntimePort;
  hooks: readonly LocalHookPort[];
}): LocalHookManager {
  const hintsBySession = new Map<string, SkillClassificationHint[]>();
  const activeSessions = new Set<string>();
  let unsubscribePostRollbackEvents: (() => void) | undefined;

  function disposePostRollbackSubscription(): void {
    unsubscribePostRollbackEvents?.();
    unsubscribePostRollbackEvents = undefined;
  }

  function ensurePostRollbackSubscription(): void {
    unsubscribePostRollbackEvents ??= input.runtime.inspect.events.subscribe((event) => {
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
      let result: NonBlockingLocalHookResult;
      try {
        result = normalizeNonBlockingHookResult(
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

  input.extensionApi.on(
    "tool_call",
    async (event, ctx): Promise<BrewvaHostToolCallResult | undefined> => {
      const sessionId = getSessionId(ctx);
      for (const hook of input.hooks) {
        const preEffect = resolvePreEffectHook(hook);
        if (!preEffect) {
          continue;
        }
        const result = await preEffect({
          phase: "pre_effect",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        });
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
        if (result.kind === "block_tool") {
          return { block: true, reason: result.reason };
        }
      }
      return undefined;
    },
  );

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
      const normalized = normalizeNonBlockingHookResult("post_receipt", result);
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
        const collected: SkillClassificationHint[] = [];
        for (const hook of input.hooks) {
          const preAdmission = resolvePreAdmissionHook(hook);
          if (!preAdmission) {
            continue;
          }
          const result = normalizeNonBlockingHookResult(
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
          if (result.kind === "recommend") {
            collected.push(...extractClassificationHints(result.recommendations));
          }
        }
        hintsBySession.set(sessionId, collected);
        return undefined;
      },
      async turnEnd(_event, ctx) {
        const sessionId = getSessionId(ctx);
        for (const hook of input.hooks) {
          const postTerminal = resolvePostTerminalHook(hook);
          if (!postTerminal) {
            continue;
          }
          const result = normalizeNonBlockingHookResult(
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
        hintsBySession.delete(sessionId);
        activeSessions.delete(sessionId);
        if (activeSessions.size === 0) {
          disposePostRollbackSubscription();
        }
        return undefined;
      },
    },
    getClassificationHints(sessionId) {
      return hintsBySession.get(sessionId) ?? [];
    },
    clear(sessionId) {
      hintsBySession.delete(sessionId);
      activeSessions.delete(sessionId);
      if (activeSessions.size === 0) {
        disposePostRollbackSubscription();
      }
    },
    dispose() {
      hintsBySession.clear();
      activeSessions.clear();
      disposePostRollbackSubscription();
    },
  };
}
