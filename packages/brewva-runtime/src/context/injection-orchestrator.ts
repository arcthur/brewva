import type { ContextBudgetUsage, TruthState } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { resolveContextUsageRatio } from "../utils/token.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  RegisterContextInjectionInput,
} from "./injection.js";
import type { ContextSourceProviderRegistry } from "./provider.js";

export interface BuildContextInjectionInput {
  sessionId: string;
  prompt: string;
  usage?: ContextBudgetUsage;
  injectionScopeId?: string;
}

export interface BuildContextInjectionResult {
  text: string;
  entries: ContextInjectionEntry[];
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}

export interface ContextInjectionOrchestratorDeps {
  providers: ContextSourceProviderRegistry;
  getMaxInjectionTokens(sessionId: string, usage?: ContextBudgetUsage): number;
  isContextBudgetEnabled(): boolean;
  sanitizeInput(text: string): string;
  getTruthState(sessionId: string): TruthState;
  maybeAlignTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): void;
  registerContextInjection(sessionId: string, input: RegisterContextInjectionInput): void;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }): void;
  planContextInjection(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult;
  commitContextInjection(sessionId: string, consumedKeys: string[]): void;
  planBudgetInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
  ): {
    accepted: boolean;
    finalText: string;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  };
  buildInjectionScopeKey(sessionId: string, injectionScopeId?: string): string;
  setReservedPrimaryTokens(scopeKey: string, tokens: number): void;
  getLastInjectedFingerprint(scopeKey: string): string | undefined;
  setLastInjectedFingerprint(scopeKey: string, fingerprint: string): void;
}

export function buildContextInjection(
  deps: ContextInjectionOrchestratorDeps,
  input: BuildContextInjectionInput,
): BuildContextInjectionResult {
  const promptText = deps.sanitizeInput(input.prompt);
  const truthState = deps.getTruthState(input.sessionId);

  deps.maybeAlignTaskStatus({
    sessionId: input.sessionId,
    promptText,
    truthState,
    usage: input.usage,
  });

  deps.providers.collect({
    sessionId: input.sessionId,
    promptText,
    usage: input.usage,
    injectionScopeId: input.injectionScopeId,
    register: (registration) => deps.registerContextInjection(input.sessionId, registration),
  });

  const merged = deps.planContextInjection(
    input.sessionId,
    deps.isContextBudgetEnabled()
      ? deps.getMaxInjectionTokens(input.sessionId, input.usage)
      : Number.MAX_SAFE_INTEGER,
  );

  const decision = deps.planBudgetInjection(input.sessionId, merged.text, input.usage);
  const wasTruncated = decision.truncated || merged.truncated;
  if (decision.accepted) {
    const fingerprint = sha256(decision.finalText);
    const scopeKey = deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId);
    const previous = deps.getLastInjectedFingerprint(scopeKey);
    if (previous === fingerprint) {
      deps.setReservedPrimaryTokens(scopeKey, 0);
      deps.commitContextInjection(input.sessionId, merged.consumedKeys);
      deps.recordEvent({
        sessionId: input.sessionId,
        type: "context_injection_dropped",
        payload: {
          reason: "duplicate_content",
          originalTokens: decision.originalTokens,
        },
      });
      return {
        text: "",
        entries: merged.entries,
        accepted: false,
        originalTokens: decision.originalTokens,
        finalTokens: 0,
        truncated: false,
      };
    }

    deps.commitContextInjection(input.sessionId, merged.consumedKeys);
    deps.setReservedPrimaryTokens(
      scopeKey,
      deps.isContextBudgetEnabled() ? decision.finalTokens : 0,
    );
    deps.setLastInjectedFingerprint(scopeKey, fingerprint);
    deps.recordEvent({
      sessionId: input.sessionId,
      type: "context_injected",
      payload: {
        originalTokens: decision.originalTokens,
        finalTokens: decision.finalTokens,
        truncated: wasTruncated,
        degradationApplied: merged.planTelemetry.degradationApplied,
        usagePercent: resolveContextUsageRatio(input.usage),
        sourceCount: merged.entries.length,
      },
    });
    return {
      text: decision.finalText,
      entries: merged.entries,
      accepted: true,
      originalTokens: decision.originalTokens,
      finalTokens: decision.finalTokens,
      truncated: wasTruncated,
    };
  }

  deps.setReservedPrimaryTokens(
    deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId),
    0,
  );
  deps.recordEvent({
    sessionId: input.sessionId,
    type: "context_injection_dropped",
    payload: {
      reason: "hard_limit",
      originalTokens: decision.originalTokens,
    },
  });
  return {
    text: "",
    entries: merged.entries,
    accepted: false,
    originalTokens: decision.originalTokens,
    finalTokens: 0,
    truncated: false,
  };
}
