import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  projectOperatorSafetyDecision,
  renderOperatorSafetyRecoveryHint,
  resolveToolAuthority,
} from "@brewva/brewva-runtime/security";
import { truncateText } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  BrewvaHostInputEventResult as InputEventResult,
  InternalHostPluginApi,
  BrewvaHostToolResultEvent as ToolResultEvent,
} from "@brewva/brewva-substrate/host-api";
import {
  BrewvaPromptContentPart,
  brewvaPromptContentPartsEqual,
  mapBrewvaPromptTextParts,
} from "@brewva/brewva-substrate/prompt";
import { buildBrewvaEditDiffPreview } from "@brewva/brewva-substrate/tools";
import {
  collectStringEnumContractMismatches,
  getBrewvaAgentParameters,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
} from "@brewva/brewva-tools/registry";
import { coerceContextBudgetUsage } from "@brewva/brewva-vocabulary/context";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { classifyToolFailure } from "@brewva/brewva-vocabulary/iteration";
import type { EffectCommitmentDiffPreview } from "@brewva/brewva-vocabulary/iteration";
import {
  sanitizeRuntimeContextInput,
  startRuntimeToolInvocation,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
import {
  isCapabilityAuthorityGated,
  loadRuntimeCapabilityRegistry,
  readLatestCapabilitySelectionReceipt,
  resolveCapabilityAuthorityAccess,
} from "./capability-selection.js";

interface QualityGateToolCallResult {
  block?: boolean;
  reason?: string;
}

interface QualityGateToolResultResult {
  content?: ToolResultEvent["content"];
}

interface RuntimeCapabilityAccessFact extends ProtocolRecord {
  allowed: boolean;
  basis: string;
  receiptId?: string;
  source?: string;
  selectedCapabilityNames?: readonly string[];
  reason?: string;
  advisory?: string;
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

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function readRuntimeRequiredCapabilities(value: unknown): {
  valid: boolean;
  requiredCapabilities: string[];
} {
  if (value === undefined) {
    return { valid: true, requiredCapabilities: [] };
  }
  if (!Array.isArray(value)) {
    return { valid: false, requiredCapabilities: [] };
  }
  const capabilities = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (capabilities.length !== value.length) {
    return { valid: false, requiredCapabilities: [] };
  }
  return {
    valid: true,
    requiredCapabilities: [...new Set(capabilities)].toSorted(),
  };
}

function resolveRuntimeCapabilityAccess(input: {
  toolName: string;
  args?: Record<string, unknown>;
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  toolDefinitionsByName?: ReadonlyMap<string, Parameters<typeof getBrewvaAgentParameters>[0]>;
}): RuntimeCapabilityAccessFact {
  const toolDefinition = input.toolDefinitionsByName?.get(input.toolName);
  const metadata = isRecord((toolDefinition as { brewva?: unknown } | undefined)?.brewva)
    ? ((toolDefinition as { brewva?: Record<string, unknown> }).brewva ?? {})
    : undefined;
  const required = readRuntimeRequiredCapabilities(metadata?.requiredCapabilities);
  if (!required.valid) {
    return {
      allowed: false,
      basis: "runtime_capability_scope",
      reason: `runtime_capability_scope_invalid:${input.toolName}`,
    };
  }
  const actionClass = getBrewvaToolMetadata(toolDefinition)?.actionClass;
  const forceCapabilityGate = getBrewvaToolSurface(input.toolName) === "operator";
  const requiresCapabilitySelection = isCapabilityAuthorityGated({
    toolName: input.toolName,
    actionClass,
    args: input.args,
    forceCapabilityGate,
  });
  if (!requiresCapabilitySelection) {
    return {
      allowed: true,
      basis:
        required.requiredCapabilities.length > 0
          ? "runtime_capability_scope"
          : "capability_selection_scope",
      advisory:
        required.requiredCapabilities.length > 0
          ? `runtime_capabilities:${required.requiredCapabilities.join(",")}`
          : undefined,
    };
  }
  const registry = loadRuntimeCapabilityRegistry(input.runtime);
  const selectedCapabilityAccess = resolveCapabilityAuthorityAccess({
    receipt: readLatestCapabilitySelectionReceipt({
      runtime: input.runtime,
      sessionId: input.sessionId,
    }),
    manifests: registry.manifests,
    toolName: input.toolName,
    actionClass,
    args: input.args,
    forceCapabilityGate,
  });
  if (!selectedCapabilityAccess.allowed) {
    return selectedCapabilityAccess;
  }
  if (required.requiredCapabilities.length === 0) {
    return {
      allowed: true,
      basis: selectedCapabilityAccess.basis,
      receiptId: selectedCapabilityAccess.receiptId,
      source: selectedCapabilityAccess.source,
      selectedCapabilityNames: selectedCapabilityAccess.selectedCapabilityNames,
      advisory: selectedCapabilityAccess.advisory,
    };
  }
  return {
    allowed: true,
    basis: "runtime_capability_scope",
    receiptId: selectedCapabilityAccess.receiptId,
    source: selectedCapabilityAccess.source,
    selectedCapabilityNames: selectedCapabilityAccess.selectedCapabilityNames,
    advisory: [
      selectedCapabilityAccess.advisory,
      `runtime_capabilities:${required.requiredCapabilities.join(",")}`,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("; "),
  };
}

function renderMissingCapabilityRecoveryHint(input: {
  toolName: string;
  args?: Record<string, unknown>;
  runtimeCapabilityAccess: RuntimeCapabilityAccessFact;
  toolDefinitionsByName?: ReadonlyMap<string, Parameters<typeof getBrewvaAgentParameters>[0]>;
}): string {
  const authority = resolveToolAuthority(input.toolName, undefined, input.args);
  const toolDefinition = input.toolDefinitionsByName?.get(input.toolName);
  const actionClass =
    authority.actionClass ??
    getBrewvaToolMetadata(toolDefinition)?.actionClass ??
    "external_side_effect";
  const receiptIds = input.runtimeCapabilityAccess.receiptId
    ? [input.runtimeCapabilityAccess.receiptId]
    : [];
  const view = projectOperatorSafetyDecision({
    kernelDecision: "deny",
    kernelReason: "missing_selected_capability",
    toolName: input.toolName,
    actionClass,
    effectBoundary: authority.boundary,
    consequencePosture: authority.commitmentPosture?.recoverability ?? "manual_recovery",
    manifestBasis: authority.manifestBasis,
    policyBasis: [input.runtimeCapabilityAccess.basis],
    targetScope: input.runtimeCapabilityAccess.selectedCapabilityNames ?? [],
    receiptIds,
    capabilityBasis: {
      allowed: false,
      ...(input.runtimeCapabilityAccess.receiptId
        ? { receiptId: input.runtimeCapabilityAccess.receiptId }
        : {}),
      ...(input.runtimeCapabilityAccess.source
        ? { source: input.runtimeCapabilityAccess.source }
        : {}),
      ...(input.runtimeCapabilityAccess.selectedCapabilityNames
        ? { selectedCapabilityNames: input.runtimeCapabilityAccess.selectedCapabilityNames }
        : {}),
      reason: input.runtimeCapabilityAccess.reason ?? "missing_selected_capability",
    },
  });
  return renderOperatorSafetyRecoveryHint(view.denialReason);
}

export function createQualityGateLifecycle(
  runtime: HostedRuntimeAdapterPort,
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

  const buildDiffPreview = (input: {
    toolName: string;
    args?: Record<string, unknown>;
    cwd?: string;
  }): EffectCommitmentDiffPreview | undefined => {
    if (input.toolName !== "edit" || !input.args || !options.toolDefinitionsByName?.has("edit")) {
      return undefined;
    }
    const rawPath = typeof input.args.path === "string" ? input.args.path : undefined;
    if (!rawPath || rawPath.trim().length === 0) {
      return undefined;
    }
    const basePath = input.cwd?.trim() || process.cwd();
    const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath);
    if (!isPathInside(basePath, absolutePath)) {
      return {
        kind: "diff",
        path: rawPath,
        error: "Diff preview is unavailable for files outside the current workspace.",
      };
    }

    try {
      accessSync(absolutePath, constants.R_OK);
      const rawContent = readFileSync(absolutePath, "utf8");
      const preview = buildBrewvaEditDiffPreview(input.args, rawContent);
      return {
        kind: "diff",
        path: preview.path,
        diff: preview.diff,
      };
    } catch (error) {
      return {
        kind: "diff",
        path: rawPath,
        error:
          error instanceof Error
            ? `Diff preview is unavailable: ${error.message}`
            : "Diff preview is unavailable.",
      };
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
        `got="${truncateText(mismatch.received, 60, { marker: "..." })}"`,
        `accepted=${mismatch.contract.canonicalValues.join("|")}`,
        mismatch.contract.defaultValue ? `default=${mismatch.contract.defaultValue}` : undefined,
        mismatch.contract.recommendedValue
          ? `recommended=${mismatch.contract.recommendedValue}`
          : undefined,
        mismatch.contract.guidance
          ? `guidance=${truncateText(mismatch.contract.guidance, 220, { marker: "..." })}`
          : undefined,
        mismatch.contract.omitGuidance
          ? `omit=${truncateText(mismatch.contract.omitGuidance, 180, { marker: "..." })}`
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
      const runtimeCapabilityAccess = resolveRuntimeCapabilityAccess({
        toolName,
        args,
        runtime,
        sessionId,
        toolDefinitionsByName: options.toolDefinitionsByName,
      });
      const started = startRuntimeToolInvocation(runtime, {
        sessionId,
        toolCallId,
        toolName,
        args,
        cwd,
        usage,
        diffPreview: buildDiffPreview({ toolName, args, cwd }),
        runtimeCapabilityAccess,
      });
      if (!started.allowed) {
        deletePendingToolState(sessionId, toolCallId);
        return {
          block: true,
          reason:
            started.reason === "missing_selected_capability"
              ? renderMissingCapabilityRecoveryHint({
                  toolName,
                  args,
                  runtimeCapabilityAccess,
                  toolDefinitionsByName: options.toolDefinitionsByName,
                })
              : (started.reason ?? "Tool call blocked by runtime policy."),
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
        runtime.ops.context.lifecycle.onUserInput(sessionId);
      }
      const parts = Array.isArray(rawEvent.parts)
        ? (rawEvent.parts as BrewvaPromptContentPart[])
        : [];
      const sanitizedParts = mapBrewvaPromptTextParts(parts, (partText) =>
        sanitizeRuntimeContextInput(runtime, partText),
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
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
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
