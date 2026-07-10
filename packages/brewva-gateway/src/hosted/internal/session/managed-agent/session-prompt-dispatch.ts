import type {
  BrewvaAgentProtocolCustomMessage,
  BrewvaAgentProtocolMessage,
} from "@brewva/brewva-substrate/agent-protocol";
import type {
  BrewvaHostContext,
  BrewvaHostCustomMessage,
  BrewvaHostPluginRunner,
} from "@brewva/brewva-substrate/host-api";
import {
  appendBrewvaSystemPromptTextSection,
  buildBrewvaPromptText,
  buildBrewvaProjectInstructionsPromptBlock,
  cloneBrewvaPromptContentParts,
  expandBrewvaPromptTemplate,
  promptPartsArePlainText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type {
  BrewvaHostedResourceLoader,
  BrewvaProjectInstructionFile,
} from "@brewva/brewva-substrate/resources";
import type {
  BrewvaPromptOptions,
  BrewvaPromptQueueBehavior,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import type { HostedTurnEnvelopeSource } from "../../turn/turn-envelope.js";
import { extractPromptTargetPaths } from "../prompt-paths.js";
import {
  buildSkillCommandText,
  buildTextPromptParts,
  parseCommand,
  toAgentUserContent,
} from "./prompt-content.js";
import {
  resolveWorkbenchContextFingerprint,
  type WorkbenchContextFingerprintInput,
} from "./provider-payload-summary.js";
import type {
  ManagedAgentSessionStore,
  PreparedManagedPromptDispatch,
} from "./session-contracts.js";
import { normalizePromptSource } from "./turn-audit.js";

// Pure prompt/turn-message shaping helpers for the managed agent session,
// extracted from session.ts so the session class keeps only orchestration.

export function appendTargetScopedProjectInstructions(input: {
  baseSystemPrompt: string;
  promptTargetPaths: readonly string[];
  resourceLoader: BrewvaHostedResourceLoader;
}): string {
  const targetInstructions: BrewvaProjectInstructionFile[] = [];
  const seen = new Set<string>();
  for (const targetPath of input.promptTargetPaths) {
    const instructionSet = input.resourceLoader.getTargetOnlyProjectInstructions(targetPath);
    for (const instruction of instructionSet.files) {
      if (seen.has(instruction.path)) {
        continue;
      }
      seen.add(instruction.path);
      targetInstructions.push(instruction);
    }
  }
  const block = buildBrewvaProjectInstructionsPromptBlock(targetInstructions, "turn");
  if (!block) {
    return input.baseSystemPrompt;
  }
  return appendBrewvaSystemPromptTextSection({
    systemPrompt: input.baseSystemPrompt,
    section: block.text,
  });
}

// Single source of truth for a custom message's display default, shared by the
// durable/context projection (toTurnLoopCustomMessage) and the display wire
// frame (the dispatch result's customMessages). Without one helper the two
// paths drifted (`?? true` vs `?? false`), so a producer that omitted `display`
// would persist-and-show in history yet be dropped from the live transcript.
function resolveCustomMessageDisplay(message: BrewvaHostCustomMessage): boolean {
  return message.display ?? true;
}

export function toTurnLoopCustomMessage(
  message: BrewvaHostCustomMessage,
): Extract<BrewvaAgentProtocolMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: resolveCustomMessageDisplay(message),
    ...(message.excludeFromContext !== undefined
      ? { excludeFromContext: message.excludeFromContext }
      : {}),
    details: message.details,
    timestamp: Date.now(),
  };
}

export function hostedTurnSourceFromPromptOptions(
  options: BrewvaPromptOptions | undefined,
): HostedTurnEnvelopeSource {
  switch (options?.source) {
    case "interactive":
      return "interactive";
    case "extension":
      return "gateway";
    default:
      return "gateway";
  }
}

export function promptPartsFromCustomMessage(
  message: BrewvaHostCustomMessage,
): readonly BrewvaPromptContentPart[] {
  return [{ type: "text", text: message.content }];
}

export interface ManagedPromptDispatchDeps {
  readonly runner: BrewvaHostPluginRunner;
  readonly resourceLoader: BrewvaHostedResourceLoader;
  readonly catalog: BrewvaMutableModelCatalog;
  readonly sessionManager: ManagedAgentSessionStore;
  readonly isStreaming: () => boolean;
  readonly getModel: () => BrewvaSessionModelDescriptor | undefined;
  readonly getBaseSystemPrompt: () => string;
  readonly consumeNextTurnMessages: () => readonly BrewvaAgentProtocolCustomMessage[];
  readonly createHostContext: () => BrewvaHostContext;
  readonly waitForProviderCacheSessionClear: () => Promise<void>;
  readonly applyQueuedModelPreset: () => Promise<void>;
  readonly tryExecuteRegisteredCommand: (name: string, args: string) => Promise<boolean>;
  readonly flushCommandDispatchBuffer: () => Promise<void>;
  readonly ensureInitialPersistence: () => Promise<void>;
  readonly queueUserMessage: (
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ) => Promise<void>;
  readonly appendPassiveCustomMessage: (
    customMessage: BrewvaAgentProtocolCustomMessage,
    options?: { transcript?: boolean },
  ) => Promise<void>;
  readonly applyPromptOverlay: (systemPrompt: string) => void;
  readonly setWorkbenchContextFingerprint: (value: WorkbenchContextFingerprintInput) => void;
  readonly syncContextState: () => Promise<void>;
}

function lastAssistantMessageText(
  messages: readonly BrewvaAgentProtocolMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.length > 0 ? content : undefined;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter((entry) => entry.length > 0)
        .join("\n");
      return text.length > 0 ? text : undefined;
    }
    return undefined;
  }
  return undefined;
}

export async function prepareManagedPromptDispatch(
  deps: ManagedPromptDispatchDeps,
  parts: readonly BrewvaPromptContentPart[],
  options?: BrewvaPromptOptions,
): Promise<PreparedManagedPromptDispatch> {
  await deps.waitForProviderCacheSessionClear();
  await deps.applyQueuedModelPreset();
  const expandPromptTemplates = options?.expandPromptTemplates ?? true;
  let currentParts = cloneBrewvaPromptContentParts(parts);
  const command =
    expandPromptTemplates && promptPartsArePlainText(currentParts)
      ? parseCommand(buildBrewvaPromptText(currentParts))
      : null;
  if (command) {
    const handled = await deps.tryExecuteRegisteredCommand(command.name, command.args);
    if (handled) {
      await deps.flushCommandDispatchBuffer();
      return { status: "handled" };
    }
  }

  await deps.ensureInitialPersistence();

  if (deps.runner.hasHandlers("input")) {
    const result = await deps.runner.emitInput(
      {
        type: "input",
        text: buildBrewvaPromptText(currentParts),
        parts: currentParts,
        source: options?.source,
      },
      deps.createHostContext(),
    );
    if (result.action === "handled") {
      return { status: "handled" };
    }
    if (result.action === "transform") {
      currentParts = cloneBrewvaPromptContentParts(result.parts);
    }
  }

  if (expandPromptTemplates && promptPartsArePlainText(currentParts)) {
    let expandedText = buildBrewvaPromptText(currentParts);
    expandedText = buildSkillCommandText(expandedText, deps.resourceLoader);
    expandedText = expandBrewvaPromptTemplate(
      expandedText,
      deps.resourceLoader.getPrompts().prompts,
    );
    currentParts = buildTextPromptParts(expandedText);
  }

  if (deps.isStreaming()) {
    const behavior = options?.streamingBehavior ?? "queue";
    await deps.queueUserMessage(currentParts, behavior);
    return { status: "queued" };
  }

  const model = deps.getModel();
  if (!model) {
    throw new Error("No model selected.");
  }
  if (!deps.catalog.hasConfiguredAuth(model as BrewvaRegisteredModel)) {
    throw new Error(`No API key found for ${model.provider}/${model.id}.`);
  }

  const restoredMessages = deps.sessionManager.buildSessionContext()
    .messages as BrewvaAgentProtocolMessage[];
  const messages: BrewvaAgentProtocolMessage[] = [
    ...restoredMessages,
    {
      role: "user",
      content: toAgentUserContent(currentParts),
      timestamp: Date.now(),
    },
    ...deps.consumeNextTurnMessages(),
  ];

  const promptText = buildBrewvaPromptText(currentParts);
  const promptTargetPaths = extractPromptTargetPaths(promptText);
  const systemPrompt = appendTargetScopedProjectInstructions({
    baseSystemPrompt: deps.getBaseSystemPrompt(),
    promptTargetPaths,
    resourceLoader: deps.resourceLoader,
  });

  const previousAssistantText = lastAssistantMessageText(restoredMessages);
  const beforeStart = await deps.runner.emitBeforeAgentStart(
    {
      type: "before_agent_start",
      prompt: promptText,
      parts: cloneBrewvaPromptContentParts(currentParts),
      promptPaths: promptTargetPaths,
      systemPrompt,
      ...(previousAssistantText ? { previousAssistantText } : {}),
    },
    deps.createHostContext(),
  );
  if (beforeStart?.messages) {
    for (const message of beforeStart.messages) {
      messages.push(toTurnLoopCustomMessage(message));
    }
  }
  deps.setWorkbenchContextFingerprint(resolveWorkbenchContextFingerprint(beforeStart?.messages));
  const transformedMessages = (await deps.runner.emitContext(
    { type: "context", messages },
    deps.createHostContext(),
  )) as BrewvaAgentProtocolMessage[];
  messages.length = 0;
  messages.push(...transformedMessages);
  for (const message of beforeStart?.messages ?? []) {
    await deps.appendPassiveCustomMessage(toTurnLoopCustomMessage(message), {
      transcript: true,
    });
  }

  deps.applyPromptOverlay(beforeStart?.systemPrompt ?? systemPrompt);
  await deps.syncContextState();
  return {
    status: "ready",
    promptText,
    promptContent: cloneBrewvaPromptContentParts(currentParts),
    messages,
    customMessages: (beforeStart?.messages ?? []).map((message) => ({
      customType: message.customType,
      content: message.content,
      display: resolveCustomMessageDisplay(message),
    })),
    source: normalizePromptSource(options?.source),
  };
}
