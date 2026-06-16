import { type Content, FinishReason, FunctionCallingConfigMode, type Part } from "@google/genai";
import type {
  Context,
  ImageContent,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  Tool,
} from "../../../contracts/index.js";
import { sanitizeSurrogates } from "../../../utils/sanitize-unicode.js";
import {
  buildGoogleFileDataPart,
  materializeResolvedUserMessageContentPart,
  resolveUserMessageContent,
} from "../prompt-content.js";
import { transformMessages } from "../transform-messages.js";

export type GoogleApiType = "google-genai";

export function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

export function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  const majorVersion = match?.[1];
  if (!majorVersion) return undefined;
  return Number.parseInt(majorVersion, 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  if (geminiMajorVersion !== undefined) {
    return geminiMajorVersion >= 3;
  }
  return true;
}

export function convertMessages<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
  options?: Pick<StreamOptions, "resolveFile">,
): Content[] {
  const contents: Content[] = [];
  const normalizeToolCallId = (id: string): string => {
    if (!requiresToolCallId(model.id)) return id;
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      const parts: Part[] = [];
      for (const item of resolveUserMessageContent(model, msg.content, options)) {
        if (item.type === "text") {
          parts.push({ text: sanitizeSurrogates(item.text) });
          continue;
        }
        if (item.type === "image") {
          parts.push({
            inlineData: {
              mimeType: item.mimeType,
              data: item.data,
            },
          });
          continue;
        }
        const nativeFile = buildGoogleFileDataPart(item);
        if (nativeFile) {
          parts.push(nativeFile);
          continue;
        }
        for (const materialized of materializeResolvedUserMessageContentPart(model, item)) {
          if (materialized.type === "text") {
            parts.push({ text: sanitizeSurrogates(materialized.text) });
            continue;
          }
          parts.push({
            inlineData: {
              mimeType: materialized.mimeType,
              data: materialized.data,
            },
          });
        }
      }
      const filteredParts = !model.input.includes("image")
        ? parts.filter((part) => part.text !== undefined || part.fileData !== undefined)
        : parts;
      if (filteredParts.length === 0) continue;
      contents.push({
        role: "user",
        parts: filteredParts,
      });
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text || block.text.trim() === "") continue;
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...(thoughtSignature && { thoughtSignature }),
          });
        } else if (block.type === "thinking") {
          if (!block.thinking || block.thinking.trim() === "") continue;
          if (isSameProviderAndModel) {
            const thoughtSignature = resolveThoughtSignature(
              isSameProviderAndModel,
              block.thinkingSignature,
            );
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              ...(thoughtSignature && { thoughtSignature }),
            });
          } else {
            parts.push({
              text: sanitizeSurrogates(block.thinking),
            });
          }
        } else if (block.type === "toolCall") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thoughtSignature,
          );
          const isGemini3 = model.id.toLowerCase().includes("gemini-3");
          const effectiveSignature =
            thoughtSignature || (isGemini3 ? SKIP_THOUGHT_SIGNATURE : undefined);
          const part: Part = {
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(effectiveSignature && { thoughtSignature: effectiveSignature }),
          };
          parts.push(part);
        }
      }

      if (parts.length === 0) continue;
      contents.push({
        role: "model",
        parts,
      });
    } else if (msg.role === "toolResult") {
      const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
      const textResult = textContent.map((c) => c.text).join("\n");
      const imageContent = model.input.includes("image")
        ? msg.content.filter((c): c is ImageContent => c.type === "image")
        : [];

      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;

      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

      const responseValue = hasText
        ? sanitizeSurrogates(textResult)
        : hasImages
          ? "(see attached image)"
          : "";

      const imageParts: Part[] = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));

      const includeId = requiresToolCallId(model.id);
      const functionResponsePart: Part = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
          ...(includeId ? { id: msg.toolCallId } : {}),
        },
      };

      const lastContent = contents[contents.length - 1];
      if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: "user",
          parts: [functionResponsePart],
        });
      }

      if (hasImages && !modelSupportsMultimodalFunctionResponse) {
        contents.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }

  return contents;
}

export function convertTools(
  tools: Tool[],
  useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(useParameters
          ? { parameters: tool.parameters }
          : { parametersJsonSchema: tool.parameters }),
      })),
    },
  ];
}

export function mapToolChoice(choice: string): FunctionCallingConfigMode {
  switch (choice) {
    case "auto":
      return FunctionCallingConfigMode.AUTO;
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "any":
      return FunctionCallingConfigMode.ANY;
    default:
      return FunctionCallingConfigMode.AUTO;
  }
}

export function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
