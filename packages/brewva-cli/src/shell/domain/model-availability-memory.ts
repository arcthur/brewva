/**
 * Session-scoped memory of models that failed at request time because the
 * account is not entitled to them (e.g. a Codex `-max` tier rejected by a
 * ChatGPT-plan credential). `hasConfiguredAuth` cannot catch this — the provider
 * has a credential, but that credential's plan does not include the model — so
 * the model picker reads this memory to badge such models instead of letting the
 * user re-pick one that just failed. Cleared when the model is used successfully.
 */
export interface ModelAvailabilityMemory {
  markUnavailable(provider: string, modelId: string, reason: string): void;
  getUnavailableReason(provider: string, modelId: string): string | undefined;
  clear(provider: string, modelId: string): void;
}

function key(provider: string, modelId: string): string {
  return `${provider} ${modelId}`;
}

export function createModelAvailabilityMemory(): ModelAvailabilityMemory {
  const reasons = new Map<string, string>();
  return {
    markUnavailable(provider, modelId, reason) {
      if (!provider || !modelId) {
        return;
      }
      reasons.set(key(provider, modelId), reason);
    },
    getUnavailableReason(provider, modelId) {
      return reasons.get(key(provider, modelId));
    },
    clear(provider, modelId) {
      reasons.delete(key(provider, modelId));
    },
  };
}
