import { isRecord } from "@brewva/brewva-std/unknown";
import { parse as partialParse } from "partial-json";
import type {
  StreamingParseRegistry,
  StreamingParseResult,
  StreamingParseStatus,
} from "./types.js";

export interface StreamingJsonParseResult {
  parseStatus?: StreamingParseStatus;
  output: Record<string, unknown>;
  unmetConstraints?: string[];
}

export function parseStreamingJson(
  partialJson: string | undefined,
  toolName?: string,
  parseRegistry?: StreamingParseRegistry,
): StreamingJsonParseResult {
  const schema = toolName && parseRegistry ? parseRegistry.get(toolName) : undefined;

  if (!partialJson || partialJson.trim() === "") {
    return { parseStatus: schema ? "incomplete" : undefined, output: {} };
  }

  let parsed: unknown;
  let recoveredFromPartialJson = false;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    try {
      parsed = partialParse(partialJson);
      recoveredFromPartialJson = true;
      if (parsed === null || parsed === undefined) {
        return { parseStatus: schema ? "incomplete" : undefined, output: {} };
      }
    } catch {
      return { parseStatus: schema ? "incomplete" : undefined, output: {} };
    }
  }

  if (!schema) {
    if (isRecord(parsed)) {
      return { parseStatus: undefined, output: parsed as Record<string, unknown> };
    }
    return { parseStatus: undefined, output: {} };
  }

  const result: StreamingParseResult = schema.safeParse(parsed);

  return {
    parseStatus:
      recoveredFromPartialJson && result.status === "likely_invalid" ? "pending" : result.status,
    output: result.output,
    unmetConstraints:
      recoveredFromPartialJson && result.status === "likely_invalid"
        ? undefined
        : result.unmetConstraints,
  };
}
