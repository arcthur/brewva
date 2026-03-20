import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSkillCompleteTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_complete",
    label: "Skill Complete",
    description: "Validate skill outputs against contract and complete the active skill.",
    promptSnippet:
      "Validate and complete the active skill after required outputs and verification evidence are ready.",
    promptGuidelines: [
      "Do not call this until required outputs are prepared.",
      "Verification must pass or be intentionally read-only before completion.",
    ],
    parameters: Type.Object({
      outputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const outputs = isRecord(params.outputs) ? params.outputs : {};

      const completion = options.runtime.skills.validateOutputs(sessionId, outputs);
      if (!completion.ok) {
        const details = [
          completion.missing.length > 0
            ? `Missing required outputs: ${completion.missing.join(", ")}`
            : null,
          completion.invalid.length > 0
            ? `Invalid required outputs: ${completion.invalid.map((entry) => entry.name).join(", ")}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(". ");
        return failTextResult(`Skill completion rejected. ${details}`, {
          ok: false,
          missing: completion.missing,
          invalid: completion.invalid,
        });
      }

      const verification = await options.runtime.verification.verify(sessionId, undefined, {
        executeCommands: options.verification?.executeCommands,
        timeoutMs: options.verification?.timeoutMs,
      });

      if (!verification.passed) {
        return inconclusiveTextResult(
          `Verification gate blocked. Skill not completed: ${verification.missingEvidence.join(", ")}`,
          {
            ok: false,
            verification,
          },
        );
      }

      options.runtime.skills.complete(sessionId, outputs);
      const message = verification.readOnly
        ? "Skill completed (read-only, no verification needed)."
        : "Skill completed and verification gate passed.";
      return textResult(message, {
        ok: true,
        verification,
      });
    },
  });
}
