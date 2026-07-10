import type { RuntimeToolExecutorPort, ToolExecutionResult } from "@brewva/brewva-runtime";
import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaToolDefinition, BrewvaToolResult } from "@brewva/brewva-substrate/tools";
import {
  assertSupportedToolOutcomeVersion,
  DEFAULT_TOOL_OUTCOME_VERSION,
  outcomeDisplayVerdict,
  outcomeIsWireError,
  ToolErrorRecordSchema,
  ToolJsonRecordSchema,
  validateOutcomeAgainstSchemas,
} from "@brewva/brewva-substrate/tools";
import { resolveToolDisplay } from "../session/tools/tool-output-display.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { advertisedToolIdentity } from "./runtime-provider-context.js";
import { isRuntimeToolSession } from "./runtime-turn-session.js";

function textFromToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const textParts = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const type = (item as { type?: unknown }).type;
    if (type !== "text") {
      return [];
    }
    const text = (item as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  return textParts.join("\n");
}

function assertToolOutcomeMatchesSchema(
  tool: BrewvaToolDefinition,
  result: BrewvaToolResult,
): void {
  if (
    !validateOutcomeAgainstSchemas({
      outputSchema: tool.outputSchema ?? ToolJsonRecordSchema,
      errorSchema: tool.errorSchema ?? ToolErrorRecordSchema,
      outcome: result.outcome,
    })
  ) {
    throw new Error(`tool_outcome_schema_mismatch:${tool.name}:${result.outcome.kind}`);
  }
}

function toolExecutionResultFromHostedResult(
  tool: BrewvaToolDefinition,
  result: BrewvaToolResult,
): ToolExecutionResult {
  assertToolOutcomeMatchesSchema(tool, result);
  const outcomeVersion = assertSupportedToolOutcomeVersion(
    tool.outcomeVersion ?? DEFAULT_TOOL_OUTCOME_VERSION,
  );
  const metadata: Record<string, JsonValue> = { outcomeVersion };
  if (result.display !== undefined) {
    metadata.display = toJsonValue(result.display);
  }
  return {
    outcome: result.outcome,
    content: result.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function toolExecutionResultFromHostedUpdate(
  tool: BrewvaToolDefinition,
  update: BrewvaToolResult,
): ToolExecutionResult {
  assertToolOutcomeMatchesSchema(tool, update);
  const outcomeVersion = assertSupportedToolOutcomeVersion(
    tool.outcomeVersion ?? DEFAULT_TOOL_OUTCOME_VERSION,
  );
  const display = resolveToolDisplay({
    toolName: tool.name,
    isError: outcomeIsWireError(update.outcome),
    result: update,
  });
  return {
    outcome: update.outcome,
    content: update.content,
    metadata: {
      outcomeVersion,
      verdict: outcomeDisplayVerdict(update.outcome),
      ...(display.display ? { display: toJsonValue(display.display) } : {}),
    },
  };
}

// Verify the live registration against the identity persisted with the canonical
// `tool.proposed` commitment. The HarnessManifest id is correlation-only; advisory
// manifest events never become execution authority. Legacy commitments with neither
// field predate proposal receipts and pass this gate, while a partial receipt fails
// closed.
function verifyProposalToolIdentity(input: {
  readonly proposalManifestId: string | undefined;
  readonly proposalToolIdentityHash: string | undefined;
  readonly tool: BrewvaToolDefinition;
}): void {
  const { proposalManifestId, proposalToolIdentityHash, tool } = input;
  if (proposalManifestId === undefined && proposalToolIdentityHash === undefined) {
    return;
  }
  if (proposalManifestId === undefined) {
    throw new Error(`hosted_runtime_tool_proposal_unresolved:${tool.name}`);
  }
  if (proposalToolIdentityHash === undefined) {
    throw new Error(`hosted_runtime_tool_not_advertised:${tool.name}`);
  }
  const live = advertisedToolIdentity({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  if (proposalToolIdentityHash !== live) {
    throw new Error(`hosted_runtime_tool_identity_drift:${tool.name}`);
  }
}

// Levenshtein edit distance between two tool names.
function toolNameEditDistance(a: string, b: string): number {
  const width = b.length + 1;
  let previous = Array.from({ length: width }, (_, index) => index);
  let current = Array.from({ length: width }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j < width; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

// Suggest the closest registered tool name for a not-found call so a model that
// hallucinated a near-miss (e.g. task_view_status for the real task_view_state)
// can self-correct from the aborted tool result. Only a genuinely close match is
// offered; a large edit distance would steer the model toward an unrelated tool.
function closestToolName(target: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const distance = toolNameEditDistance(target, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  if (best === undefined || bestDistance === 0) {
    return undefined;
  }
  const threshold = Math.max(2, Math.floor(target.length / 4));
  return bestDistance <= threshold ? best : undefined;
}

export function createHostedRuntimeToolExecutorPort(
  session: CollectSessionPromptOutputSession,
): RuntimeToolExecutorPort {
  if (!isRuntimeToolSession(session)) {
    throw new Error("hosted_runtime_tool_executor_session_incompatible");
  }
  // Every new hosted commitment carries the advertised tool identity as a canonical
  // proposal fact. The executor compares that fact with the live registration, so a
  // call cannot run a drifted or unadvertised tool and never needs an advisory
  // manifest resolver.
  const toolSession = session;
  return {
    async execute(commitment, input): Promise<ToolExecutionResult> {
      const registeredTools = toolSession.getRegisteredTools();
      const tool = registeredTools.find((candidate) => candidate.name === commitment.call.toolName);
      if (!tool) {
        const suggestion = closestToolName(
          commitment.call.toolName,
          registeredTools.map((candidate) => candidate.name),
        );
        throw new Error(
          `hosted_runtime_tool_not_found:${commitment.call.toolName}${
            suggestion === undefined ? "" : ` (did you mean ${suggestion}?)`
          }`,
        );
      }
      verifyProposalToolIdentity({
        proposalManifestId: commitment.call.proposalManifestId,
        proposalToolIdentityHash: commitment.call.proposalToolIdentityHash,
        tool,
      });
      const rawArgs = commitment.call.args ?? {};
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
      const result = await tool.execute(
        commitment.call.toolCallId,
        preparedArgs,
        input.signal,
        input.onProgress
          ? async (update) => {
              await input.onProgress?.(toolExecutionResultFromHostedUpdate(tool, update));
            }
          : undefined,
        session.createRuntimeToolContext(),
      );
      return toolExecutionResultFromHostedResult(tool, result);
    },
  };
}

export function summarizeRuntimeToolResultContent(content: unknown): string {
  return textFromToolResultContent(content);
}
