import type { ThinkingBudgets, ThinkingLevel } from "../../contracts/index.js";
import type { GoogleThinkingConfig, GoogleThinkingLevel } from "./contract.js";

export const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const GEMINI_CLI_HEADERS = {
  "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": JSON.stringify({
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  }),
};

export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 1000;
export const MAX_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

export function isGemini3ProModel(modelId: string): boolean {
  return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}

export function isGemini3FlashModel(modelId: string): boolean {
  return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}

export function isGemini3Model(modelId: string): boolean {
  return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

export function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(
    errorText,
  );
}

export function extractErrorMessage(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {}
  return errorText;
}

export function getDisabledThinkingConfig(modelId: string): GoogleThinkingConfig {
  if (isGemini3ProModel(modelId)) {
    return { thinkingLevel: "LOW" };
  }
  if (isGemini3FlashModel(modelId)) {
    return { thinkingLevel: "MINIMAL" };
  }

  return { thinkingBudget: 0 };
}

export function buildGoogleThinkingLevelConfig(level: GoogleThinkingLevel): GoogleThinkingConfig {
  if (level === "THINKING_LEVEL_UNSPECIFIED") {
    return {};
  }
  return { thinkingLevel: level };
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

export function getGeminiCliThinkingLevel(
  effort: ClampedThinkingLevel,
  modelId: string,
): GoogleThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
        return "HIGH";
    }
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
}

export function resolveThinkingBudget(
  baseMaxTokens: number,
  modelMaxTokens: number,
  thinkingLevel: Exclude<ThinkingLevel, "xhigh">,
  thinkingBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budgets = { ...defaultBudgets, ...thinkingBudgets };

  const minOutputTokens = 1024;
  let thinkingBudget = budgets[thinkingLevel]!;
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}

export function extractRetryDelay(
  errorText: string,
  response?: Response | Headers,
): number | undefined {
  const normalizeDelay = (ms: number): number | undefined =>
    ms > 0 ? Math.ceil(ms + 1000) : undefined;

  const headers = response instanceof Headers ? response : response?.headers;
  if (headers) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const retryAfterSeconds = Number(retryAfter);
      if (Number.isFinite(retryAfterSeconds)) {
        const delay = normalizeDelay(retryAfterSeconds * 1000);
        if (delay !== undefined) {
          return delay;
        }
      }
      const retryAfterDate = new Date(retryAfter);
      const retryAfterMs = retryAfterDate.getTime();
      if (!Number.isNaN(retryAfterMs)) {
        const delay = normalizeDelay(retryAfterMs - Date.now());
        if (delay !== undefined) {
          return delay;
        }
      }
    }

    const rateLimitReset = headers.get("x-ratelimit-reset");
    if (rateLimitReset) {
      const resetSeconds = Number.parseInt(rateLimitReset, 10);
      if (!Number.isNaN(resetSeconds)) {
        const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
        if (delay !== undefined) {
          return delay;
        }
      }
    }

    const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
    if (rateLimitResetAfter) {
      const resetAfterSeconds = Number(rateLimitResetAfter);
      if (Number.isFinite(resetAfterSeconds)) {
        const delay = normalizeDelay(resetAfterSeconds * 1000);
        if (delay !== undefined) {
          return delay;
        }
      }
    }
  }

  const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (durationMatch) {
    const [, hoursRaw, minutesRaw, secondsRaw] = durationMatch;
    if (!secondsRaw) {
      return undefined;
    }
    const hours = hoursRaw ? parseInt(hoursRaw, 10) : 0;
    const minutes = minutesRaw ? parseInt(minutesRaw, 10) : 0;
    const seconds = parseFloat(secondsRaw);
    if (!Number.isNaN(seconds)) {
      const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
      const delay = normalizeDelay(totalMs);
      if (delay !== undefined) {
        return delay;
      }
    }
  }

  const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
  if (retryInMatch?.[1] && retryInMatch[2]) {
    const value = parseFloat(retryInMatch[1]);
    if (!Number.isNaN(value) && value > 0) {
      const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
      const delay = normalizeDelay(ms);
      if (delay !== undefined) {
        return delay;
      }
    }
  }

  const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
  if (retryDelayMatch?.[1] && retryDelayMatch[2]) {
    const value = parseFloat(retryDelayMatch[1]);
    if (!Number.isNaN(value) && value > 0) {
      const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
      const delay = normalizeDelay(ms);
      if (delay !== undefined) {
        return delay;
      }
    }
  }

  return undefined;
}
