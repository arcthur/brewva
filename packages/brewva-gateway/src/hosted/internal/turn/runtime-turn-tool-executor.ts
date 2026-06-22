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
      const tool = toolSession
        .getRegisteredTools()
        .find((candidate) => candidate.name === commitment.call.toolName);
      if (!tool) {
        throw new Error(`hosted_runtime_tool_not_found:${commitment.call.toolName}`);
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
