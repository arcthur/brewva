import Anthropic from "@anthropic-ai/sdk";
import type { StreamOptions } from "../../contracts/index.js";

export type AnthropicEffort = "low" | "medium" | "high" | "max";

export interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: AnthropicEffort;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  client?: Anthropic;
}

export type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

export interface AnthropicCacheControlAllocator {
  claim(): AnthropicCacheControl | undefined;
  remaining(): number;
}
