import {
  TURN_GOVERNANCE_DECISION_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
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

export type LocalHookPhase = "pre_classify" | "pre_tool" | "post_tool" | "end_turn";

export interface LocalHookNote {
  readonly message: string;
  readonly severity?: "info" | "warning" | "error";
}

export interface LocalHookRecommendation {
  readonly message: string;
  readonly classificationHint?: SkillClassificationHint;
}

export interface LocalHookPreClassifyInput {
  readonly phase: "pre_classify";
  readonly sessionId: string;
  readonly prompt: string;
}

export interface LocalHookPreToolInput {
  readonly phase: "pre_tool";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface LocalHookPostToolInput {
  readonly phase: "post_tool";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly BrewvaToolContentPart[];
  readonly isError: boolean;
  readonly details?: unknown;
}

export interface LocalHookEndTurnInput {
  readonly phase: "end_turn";
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

export type LocalHookPreClassifyResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;
export type LocalHookPreToolResult = LocalHookResult | undefined;
export type LocalHookPostToolResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;
export type LocalHookEndTurnResult =
  | Extract<LocalHookResult, { kind: "observe" | "recommend" }>
  | undefined;

export interface LocalHookPort {
  readonly name: string;
  preClassify?(
    input: LocalHookPreClassifyInput,
  ): Promise<LocalHookPreClassifyResult> | LocalHookPreClassifyResult;
  preTool?(input: LocalHookPreToolInput): Promise<LocalHookPreToolResult> | LocalHookPreToolResult;
  postTool?(
    input: LocalHookPostToolInput,
  ): Promise<LocalHookPostToolResult> | LocalHookPostToolResult;
  endTurn?(input: LocalHookEndTurnInput): Promise<LocalHookEndTurnResult> | LocalHookEndTurnResult;
}

export interface LocalHookManager {
  readonly lifecycle: TurnLifecyclePort;
  getClassificationHints(sessionId: string): readonly SkillClassificationHint[];
  clear(sessionId: string): void;
}

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

export function createLocalHookManager(input: {
  extensionApi: InternalHostPluginApi;
  runtime: BrewvaHostedRuntimePort;
  hooks: readonly LocalHookPort[];
}): LocalHookManager {
  const hintsBySession = new Map<string, SkillClassificationHint[]>();

  input.extensionApi.on(
    "tool_call",
    async (event, ctx): Promise<BrewvaHostToolCallResult | undefined> => {
      const sessionId = getSessionId(ctx);
      for (const hook of input.hooks) {
        if (!hook.preTool) {
          continue;
        }
        const result = await hook.preTool({
          phase: "pre_tool",
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
          phase: "pre_tool",
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
      if (!hook.postTool) {
        continue;
      }
      const result = await hook.postTool({
        phase: "post_tool",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        content: cloneToolContentParts(event.content),
        isError: event.isError,
        ...(event.details !== undefined ? { details: cloneHookDetails(event.details) } : {}),
      });
      if (result) {
        recordGovernanceDecision({
          runtime: input.runtime,
          sessionId,
          phase: "post_tool",
          hookName: hook.name,
          result,
        });
      }
    }
    return undefined;
  });

  return {
    lifecycle: {
      async beforeAgentStart(event, ctx) {
        const sessionId = getSessionId(ctx);
        const prompt = event.prompt;
        const collected: SkillClassificationHint[] = [];
        for (const hook of input.hooks) {
          if (!hook.preClassify) {
            continue;
          }
          const result = await hook.preClassify({
            phase: "pre_classify",
            sessionId,
            prompt,
          });
          if (!result) {
            continue;
          }
          recordGovernanceDecision({
            runtime: input.runtime,
            sessionId,
            phase: "pre_classify",
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
          if (!hook.endTurn) {
            continue;
          }
          const result = await hook.endTurn({
            phase: "end_turn",
            sessionId,
          });
          if (result) {
            recordGovernanceDecision({
              runtime: input.runtime,
              sessionId,
              phase: "end_turn",
              hookName: hook.name,
              result,
            });
          }
        }
        return undefined;
      },
      sessionShutdown(_event, ctx) {
        hintsBySession.delete(getSessionId(ctx));
        return undefined;
      },
    },
    getClassificationHints(sessionId) {
      return hintsBySession.get(sessionId) ?? [];
    },
    clear(sessionId) {
      hintsBySession.delete(sessionId);
    },
  };
}
