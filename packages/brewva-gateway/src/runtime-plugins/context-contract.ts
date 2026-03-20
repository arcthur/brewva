import type { BrewvaRuntime, ContextBudgetUsage } from "@brewva/brewva-runtime";
import { formatPercent } from "./context-shared.js";

const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";

export function buildContextContractBlock(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  usage?: ContextBudgetUsage;
}): string {
  const highThresholdPercent = formatPercent(
    input.runtime.context.getCompactionThresholdRatio(input.sessionId, input.usage),
  );
  const hardLimitPercent = formatPercent(
    input.runtime.context.getHardLimitRatio(input.sessionId, input.usage),
  );

  return [
    CONTEXT_CONTRACT_MARKER,
    "Operating model:",
    "- `tape_handoff` records durable handoff state; it does not reduce message tokens.",
    "- `session_compact` reduces message-history pressure; it does not rewrite tape semantics.",
    "- If a compaction gate or advisory block appears, follow it before broad tool work.",
    "- Prefer current task state, supplemental context, and working projection before replaying tape.",
    "Hard rules:",
    "- call `session_compact` directly, never through `exec` or shell wrappers.",
    `- compact soon when context pressure reaches high (${highThresholdPercent}).`,
    `- compact immediately when context pressure becomes critical (${hardLimitPercent}).`,
  ].join("\n");
}

export function applyContextContract(
  systemPrompt: unknown,
  runtime: BrewvaRuntime,
  sessionId: string,
  usage?: ContextBudgetUsage,
): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  const markerIndex = base.indexOf(CONTEXT_CONTRACT_MARKER);
  const baseWithoutContract = markerIndex >= 0 ? base.slice(0, markerIndex).trimEnd() : base;
  const contract = buildContextContractBlock({ runtime, sessionId, usage });
  if (baseWithoutContract.trim().length === 0) {
    return contract;
  }
  return `${baseWithoutContract}\n\n${contract}`;
}

export { CONTEXT_CONTRACT_MARKER };
