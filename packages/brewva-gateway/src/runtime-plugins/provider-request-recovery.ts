import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  consumeNextPromptOutputBudgetEscalation,
  markProviderRequestRecoveryInstalled,
} from "../session/prompt-recovery-state.js";
import { recordSessionTurnTransition } from "../session/turn-transition.js";

const OUTPUT_BUDGET_PATHS = [
  ["max_tokens"],
  ["max_output_tokens"],
  ["max_completion_tokens"],
  ["maxOutputTokens"],
  ["maxCompletionTokens"],
  ["generationConfig", "maxOutputTokens"],
  ["generationConfig", "max_output_tokens"],
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getNestedNumber(payload: Record<string, unknown>, path: readonly string[]): number | null {
  let current: unknown = payload;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[segment];
  }
  return readPositiveNumber(current);
}

function setNestedNumber(
  payload: Record<string, unknown>,
  path: readonly string[],
  value: number,
): boolean {
  let current: Record<string, unknown> | null = payload;
  const leafKey = path[path.length - 1];
  if (!leafKey) {
    return false;
  }
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!current) {
      return false;
    }
    const segment = path[index];
    if (!segment) {
      return false;
    }
    const next = asRecord(current[segment]);
    if (!next) {
      return false;
    }
    current = next;
  }
  if (!current) {
    return false;
  }
  current[leafKey] = value;
  return true;
}

export function applyOutputBudgetEscalationToPayload(
  payload: unknown,
  targetMaxTokens: number,
): {
  payload: unknown;
  status: "completed" | "skipped";
  detail: string | null;
} {
  const record = asRecord(payload);
  if (!record) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload is not an object",
    };
  }

  const cloned = structuredClone(record);
  let seenSupportedField = false;
  let patched = false;

  for (const path of OUTPUT_BUDGET_PATHS) {
    const current = getNestedNumber(cloned, path);
    if (current === null) {
      continue;
    }
    seenSupportedField = true;
    if (current < targetMaxTokens) {
      patched = setNestedNumber(cloned, path, targetMaxTokens) || patched;
    }
  }

  if (patched) {
    return {
      payload: cloned,
      status: "completed",
      detail: null,
    };
  }

  return {
    payload,
    status: "skipped",
    detail: seenSupportedField
      ? "provider payload already uses the maximum configured output budget"
      : "provider payload does not expose a supported output-budget field",
  };
}

export function registerProviderRequestRecovery(
  extensionApi: ExtensionAPI,
  runtime: BrewvaRuntime,
): void {
  markProviderRequestRecoveryInstalled(runtime);
  extensionApi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId().trim();
    if (!sessionId) {
      return undefined;
    }
    const pending = consumeNextPromptOutputBudgetEscalation(runtime, sessionId);
    if (!pending) {
      return undefined;
    }

    const result = applyOutputBudgetEscalationToPayload(event.payload, pending.targetMaxTokens);
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "output_budget_escalation",
      status: result.status,
      error: result.detail,
      model: pending.model,
    });
    return result.status === "completed" ? result.payload : undefined;
  });
}

export const PROVIDER_REQUEST_RECOVERY_TEST_ONLY = {
  applyOutputBudgetEscalationToPayload,
};
