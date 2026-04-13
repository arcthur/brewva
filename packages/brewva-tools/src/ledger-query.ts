import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const LEDGER_VERDICT_VALUES = ["pass", "fail", "inconclusive"] as const;
const LedgerVerdictSchema = buildStringEnumSchema(LEDGER_VERDICT_VALUES, {
  guidance:
    "Filter by verdict only when narrowing prior evidence. Use inconclusive for partial or non-terminal results.",
});

function normalizeLedgerVerdict(value: unknown): "pass" | "fail" | "inconclusive" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return LEDGER_VERDICT_VALUES.includes(value as (typeof LEDGER_VERDICT_VALUES)[number])
    ? (value as "pass" | "fail" | "inconclusive")
    : undefined;
}

export function createLedgerQueryTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "ledger_query",
    label: "Ledger Query",
    description: "Query evidence ledger by file, skill, verdict, tool, or last N entries.",
    promptSnippet:
      "Query the evidence ledger for recent tool outcomes, files, skills, and verdicts.",
    promptGuidelines: [
      "Use this to confirm prior evidence or verdict history before repeating work.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String()),
      skill: Type.Optional(Type.String()),
      verdict: Type.Optional(LedgerVerdictSchema),
      tool: Type.Optional(Type.String()),
      last: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = {
        file: params.file,
        skill: params.skill,
        verdict: normalizeLedgerVerdict(params.verdict),
        tool: params.tool,
        last: params.last,
      };
      const text = options.runtime.inspect.ledger.query(sessionId, query);
      return textResult(text, { sessionId, query });
    },
  });
}
