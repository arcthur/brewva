import { sha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";

export function normalizePromptSource(
  source: BrewvaPromptOptions["source"] | undefined,
): string | undefined {
  if (typeof source !== "string") {
    return undefined;
  }
  const normalized = source.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildSteerAuditPayload(
  text: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chars: text.length,
    hash: sha256Hex(text),
    ...extra,
  };
}

export function resolveChannelContext(source: string | undefined): { source: string } | "" {
  return source ? { source } : "";
}
