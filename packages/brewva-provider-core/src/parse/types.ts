export type { StreamingParseStatus } from "../contracts/event.js";
import type { StreamingParseStatus } from "../contracts/event.js";

export interface StreamingParseResult {
  status: StreamingParseStatus;
  output: Record<string, unknown>;
  unmetConstraints?: string[];
}

export interface StreamingParseSchema {
  safeParse(input: unknown): StreamingParseResult;
}

export interface StreamingParseRegistry {
  get(toolName: string): StreamingParseSchema | undefined;
}
