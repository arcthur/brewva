import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaHostCustomMessage } from "@brewva/brewva-substrate/host-api";
import {
  appendBrewvaSystemPromptTextSection,
  buildBrewvaProjectInstructionsPromptBlock,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaHostedResourceLoader,
  BrewvaProjectInstructionFile,
} from "@brewva/brewva-substrate/resources";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";
import type { HostedTurnEnvelopeSource } from "../../turn-adapter/turn-envelope.js";

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

export function toTurnLoopCustomMessage(
  message: BrewvaHostCustomMessage,
): Extract<BrewvaAgentProtocolMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: message.display ?? true,
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
