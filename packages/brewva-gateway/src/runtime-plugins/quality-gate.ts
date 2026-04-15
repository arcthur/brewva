import {
  classifyToolFailure,
  coerceContextBudgetUsage,
  type BrewvaHostedRuntimePort,
} from "@brewva/brewva-runtime";
import {
  BrewvaHostInputEventResult as InputEventResult,
  BrewvaHostPluginApi,
  BrewvaPromptContentPart,
  BrewvaHostToolResultEvent as ToolResultEvent,
  brewvaPromptContentPartsEqual,
  mapBrewvaPromptTextParts,
} from "@brewva/brewva-substrate";
import {
  collectStringEnumContractMismatches,
  getBrewvaAgentParameters,
} from "@brewva/brewva-tools";

interface QualityGateToolCallResult {
  block?: boolean;
  reason?: string;
}

interface QualityGateToolResultResult {
  content?: ToolResultEvent["content"];
}

export interface QualityGateLifecycle {
  toolCall: (event: unknown, ctx: unknown) => QualityGateToolCallResult | undefined;
  toolResult: (event: unknown, ctx: unknown) => QualityGateToolResultResult | undefined;
  input: (event: unknown, ctx: unknown) => InputEventResult | undefined;
}

export interface QualityGateLifecycleOptions {
  toolDefinitionsByName?: ReadonlyMap<string, Parameters<typeof getBrewvaAgentParameters>[0]>;
}

type PendingToolState = {
  advisory?: string;
  toolName: string;
  args?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function createQualityGateLifecycle(
  runtime: BrewvaHostedRuntimePort,
  options: QualityGateLifecycleOptions = {},
): QualityGateLifecycle {
  const pendingToolStateBySession = new Map<string, Map<string, PendingToolState>>();

  const normalizeField = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value == null) {
      return "";
    }
    return JSON.stringify(value);
  };

  const getSessionId = (ctx: unknown): string =>
    ctx &&
    typeof ctx === "object" &&
    "sessionManager" in ctx &&
    (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager &&
    typeof (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager
      ?.getSessionId === "function"
      ? ((
          ctx as { sessionManager: { getSessionId: () => string } }
        ).sessionManager.getSessionId() ?? "")
      : "";

  const getPendingToolStates = (sessionId: string): Map<string, PendingToolState> => {
    const existing = pendingToolStateBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, PendingToolState>();
    pendingToolStateBySession.set(sessionId, created);
    return created;
  };

  const deletePendingToolState = (sessionId: string, toolCallId: string): void => {
    const sessionState = pendingToolStateBySession.get(sessionId);
    if (!sessionState) {
      return;
    }
    sessionState.delete(toolCallId);
    if (sessionState.size === 0) {
      pendingToolStateBySession.delete(sessionId);
    }
  };

  const normalizeToolResultContent = (value: unknown): ToolResultEvent["content"] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is ToolResultEvent["content"][number] =>
        Boolean(entry) &&
        typeof entry === "object" &&
        "type" in entry &&
        ((entry as { type?: unknown }).type === "text" ||
          (entry as { type?: unknown }).type === "image"),
    );
  };

  const extractTextContent = (value: unknown): string => {
    if (!Array.isArray(value)) {
      return "";
    }
    const lines = value
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .filter((entry) => entry.length > 0);
    return lines.join("\n");
  };

  const formatInvocationRepair = (input: {
    toolName: string;
    args?: Record<string, unknown>;
    outputText: string;
    details?: unknown;
    isError: boolean;
  }): string | undefined => {
    if (!input.toolName || !input.args) {
      return undefined;
    }
    if (
      classifyToolFailure({
        toolName: input.toolName,
        args: input.args,
        outputText: input.outputText,
        details: input.details,
        isError: input.isError,
      }) !== "invocation_validation"
    ) {
      return undefined;
    }

    const toolDefinition = options.toolDefinitionsByName?.get(input.toolName);
    const parameters = getBrewvaAgentParameters(toolDefinition);
    if (!parameters) {
      return undefined;
    }

    const mismatches = collectStringEnumContractMismatches(parameters, input.args);
    if (mismatches.length === 0) {
      return undefined;
    }

    const lines = ["[InvocationRepair]", "retry with the canonical parameter contract:"];
    for (const mismatch of mismatches.slice(0, 4)) {
      const parts = [
        `got="${truncateText(mismatch.received, 60)}"`,
        `accepted=${mismatch.contract.canonicalValues.join("|")}`,
        mismatch.contract.defaultValue ? `default=${mismatch.contract.defaultValue}` : undefined,
        mismatch.contract.recommendedValue
          ? `recommended=${mismatch.contract.recommendedValue}`
          : undefined,
        mismatch.contract.guidance
          ? `guidance=${truncateText(mismatch.contract.guidance, 220)}`
          : undefined,
        mismatch.contract.omitGuidance
          ? `omit=${truncateText(mismatch.contract.omitGuidance, 180)}`
          : undefined,
      ].filter((part): part is string => Boolean(part));
      lines.push(`${mismatch.pathText}: ${parts.join(" ; ")}`);
    }

    return lines.join("\n");
  };

  return {
    toolCall(event, ctx) {
      const rawEvent = event as { toolCallId?: unknown; toolName?: unknown; input?: unknown };
      const sessionId = getSessionId(ctx);
      const toolCallId = normalizeField(rawEvent.toolCallId);
      const toolName = normalizeField(rawEvent.toolName);
      const args = isRecord(rawEvent.input) ? rawEvent.input : undefined;
      const cwd =
        typeof (ctx as { cwd?: unknown }).cwd === "string" && (ctx as { cwd?: string }).cwd?.trim()
          ? (ctx as { cwd: string }).cwd
          : undefined;
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      const started = runtime.authority.tools.start({
        sessionId,
        toolCallId,
        toolName,
        args,
        cwd,
        usage,
      });
      if (!started.allowed) {
        deletePendingToolState(sessionId, toolCallId);
        return {
          block: true,
          reason: started.reason ?? "Tool call blocked by runtime policy.",
        };
      }
      getPendingToolStates(sessionId).set(toolCallId, {
        advisory: started.advisory?.trim() || undefined,
        toolName,
        args,
      });
      return undefined;
    },
    toolResult(event, ctx) {
      const rawEvent = event as {
        toolCallId?: unknown;
        toolName?: unknown;
        input?: unknown;
        content?: unknown;
        details?: unknown;
        isError?: unknown;
      };
      const sessionId = getSessionId(ctx);
      const toolCallId = normalizeField(rawEvent.toolCallId);
      if (!sessionId || !toolCallId) {
        return undefined;
      }

      const pending = getPendingToolStates(sessionId).get(toolCallId);
      const advisory = pending?.advisory?.trim();
      const toolName = normalizeField(rawEvent.toolName) || pending?.toolName || "";
      const args = isRecord(rawEvent.input) ? rawEvent.input : pending?.args;
      const repair = formatInvocationRepair({
        toolName,
        args,
        outputText: extractTextContent(rawEvent.content),
        details: rawEvent.details,
        isError: rawEvent.isError === true,
      });
      deletePendingToolState(sessionId, toolCallId);
      if (!advisory && !repair) {
        return undefined;
      }

      const injectedContent: ToolResultEvent["content"] = [];
      if (advisory) {
        injectedContent.push({ type: "text", text: advisory });
      }
      if (repair) {
        injectedContent.push({ type: "text", text: repair });
      }

      return {
        content: [...injectedContent, ...normalizeToolResultContent(rawEvent.content)],
      };
    },
    input(event, ctx) {
      const rawEvent = event as { text?: unknown; parts?: unknown };
      const sessionId = getSessionId(ctx);
      if (sessionId.length > 0) {
        runtime.maintain.context.onUserInput(sessionId);
      }
      const parts = Array.isArray(rawEvent.parts)
        ? (rawEvent.parts as BrewvaPromptContentPart[])
        : [];
      const sanitizedParts = mapBrewvaPromptTextParts(parts, (partText) =>
        runtime.inspect.context.sanitizeInput(partText),
      );
      if (brewvaPromptContentPartsEqual(sanitizedParts, parts)) {
        return { action: "continue" };
      }

      return {
        action: "transform",
        parts: sanitizedParts,
      };
    },
  };
}

export function registerQualityGate(
  extensionApi: BrewvaHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
  options: QualityGateLifecycleOptions = {},
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createQualityGateLifecycle(runtime, options);
  hooks.on("tool_call", lifecycle.toolCall);
  hooks.on("tool_result", lifecycle.toolResult);
  hooks.on("input", lifecycle.input);
}
