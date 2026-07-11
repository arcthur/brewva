import { compactWhitespace } from "@brewva/brewva-std/text";
import type {
  BrewvaProviderCompletionDriver,
  BrewvaProviderCompletionResponse,
  BrewvaProviderCompletionUsage,
  BrewvaRegisteredModel,
  BrewvaResolvedRequestAuth,
} from "@brewva/brewva-substrate/provider";
import { createHostedProviderCompletionClient } from "../provider/completion-client.js";

export interface BrewvaSessionTitleGenerationInput {
  sessionId: string;
  promptText: string;
  turnId: string;
  promptEventId: string;
  model: BrewvaRegisteredModel;
}

export interface BrewvaSessionTitleGenerationResult {
  title: string;
  model: {
    provider: string;
    id: string;
    api: string;
  };
  usage?: BrewvaProviderCompletionUsage;
}

export type BrewvaSessionTitleGenerator = (
  input: BrewvaSessionTitleGenerationInput,
) => Promise<BrewvaSessionTitleGenerationResult>;

export interface HostedSessionTitleGeneratorOptions {
  completionClient?: BrewvaProviderCompletionDriver;
  resolveAuth: (model: BrewvaRegisteredModel) => Promise<BrewvaResolvedRequestAuth>;
}

const TITLE_SYSTEM_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "<task>",
  "Generate a brief title that would help the user find this conversation later.",
  "",
  "Your output must be:",
  "- A single line",
  "- At most 8 words",
  "- No quotes",
  "- No markdown",
  "- No explanations",
  "</task>",
  "",
  "<rules>",
  "- You MUST use the same language as the user message you are summarizing",
  "- Title must be grammatically correct and read naturally, with no word salad",
  '- Never include tool names in the title, such as "read tool", "bash tool", or "edit tool"',
  "- Focus on the main topic or question the user needs to retrieve",
  '- Vary your phrasing and avoid repetitive patterns like always starting with "Analyzing"',
  "- When a file is mentioned, focus on what the user wants to do with the file",
  "- Keep exact technical terms, numbers, filenames, HTTP codes, identifiers, and product names",
  '- Remove filler words such as "the", "this", "my", "a", and "an" when natural',
  "- Never assume the tech stack",
  "- Never use tools",
  "- NEVER respond to questions, just generate a title for the conversation",
  '- The title should NEVER include "summarizing" or "generating" when generating a title',
  "- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT",
  "- Always output something meaningful, even if the input is minimal",
  "</rules>",
].join("\n");

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/giu, " ").trim();
}

function stripSurroundingFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return match?.[1] ? match[1].trim() : trimmed;
}

function responseText(response: BrewvaProviderCompletionResponse): string {
  const content = response.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const record = part as { type?: unknown; text?: unknown };
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

export function normalizeGeneratedSessionTitle(text: string): string {
  const withoutThinking = stripThinkingBlocks(text);
  const withoutFence = stripSurroundingFence(withoutThinking);
  const firstLine = withoutFence
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "";
  }
  const unquoted = firstLine.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "");
  const collapsed = compactWhitespace(unquoted);
  const words = collapsed.split(" ").filter((word) => word.length > 0);
  return words
    .slice(0, 8)
    .join(" ")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
}

function buildTitleUserPrompt(input: BrewvaSessionTitleGenerationInput): string {
  return ["Generate a title for this conversation:", "", input.promptText].join("\n");
}

export function createHostedSessionTitleGenerator(
  options: HostedSessionTitleGeneratorOptions,
): BrewvaSessionTitleGenerator {
  const completionClient = options.completionClient ?? createHostedProviderCompletionClient();

  return async (input) => {
    const auth = await options.resolveAuth(input.model);
    if (!auth.ok) {
      throw new Error(`session_title_auth_unavailable: ${auth.error}`);
    }
    const response = await completionClient.complete({
      model: input.model,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userText: buildTitleUserPrompt(input),
      auth: {
        apiKey: auth.apiKey,
        headers: auth.headers,
      },
      maxOutputTokens: 32,
    });
    const title = normalizeGeneratedSessionTitle(responseText(response));
    if (!title) {
      throw new Error("session_title_empty_response");
    }
    return {
      title,
      model: {
        provider: input.model.provider,
        id: input.model.id,
        api: input.model.api,
      },
      usage: response.usage,
    };
  };
}
