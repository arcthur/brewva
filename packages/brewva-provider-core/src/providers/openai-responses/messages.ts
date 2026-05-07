import { shortSha256Hex } from "@brewva/brewva-std/hash";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  StreamOptions,
  TextContent,
  TextSignatureV1,
  ToolCall,
} from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import {
  buildOpenAIInputFilePart,
  materializeResolvedUserMessageContentPart,
  resolveUserMessageContent,
} from "../_shared/prompt-content.js";
import { transformMessages } from "../_shared/transform-messages.js";
import type { ConvertResponsesMessagesOptions } from "./contract.js";

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {}
  }
  return { id: signature };
}

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
  streamOptions?: Pick<StreamOptions, "resolveFile">,
): ResponseInput {
  const messages: ResponseInput = [];

  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };

  const buildForeignResponsesItemId = (itemId: string): string => {
    const normalized = `fc_${shortSha256Hex(itemId, 16)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };

  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<TApi>,
    source: AssistantMessage,
  ): string => {
    if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
    if (!id.includes("|")) return normalizeIdPart(id);
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId ?? id);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId ?? callId ?? id)
      : normalizeIdPart(itemId ?? callId ?? id);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const role = model.reasoning ? "developer" : "system";
    messages.push({
      role,
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      const content: ResponseInputContent[] = [];
      for (const item of resolveUserMessageContent(model, msg.content, streamOptions)) {
        if (item.type === "text") {
          content.push({
            type: "input_text",
            text: sanitizeSurrogates(item.text),
          } satisfies ResponseInputText);
          continue;
        }
        if (item.type === "image") {
          content.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          } satisfies ResponseInputImage);
          continue;
        }
        const nativeFile = buildOpenAIInputFilePart(item);
        if (nativeFile) {
          content.push(nativeFile satisfies ResponseInputFile);
          continue;
        }
        for (const materialized of materializeResolvedUserMessageContentPart(model, item)) {
          if (materialized.type === "text") {
            content.push({
              type: "input_text",
              text: sanitizeSurrogates(materialized.text),
            } satisfies ResponseInputText);
            continue;
          }
          content.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${materialized.mimeType};base64,${materialized.data}`,
          } satisfies ResponseInputImage);
        }
      }
      const filteredContent = !model.input.includes("image")
        ? content.filter((c) => c.type !== "input_image")
        : content;
      if (filteredContent.length === 0) continue;
      messages.push({
        role: "user",
        content: filteredContent,
      });
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const assistantMsg = msg as AssistantMessage;
      const isDifferentModel =
        assistantMsg.model !== model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
            output.push(reasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block as TextContent;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortSha256Hex(msgId, 16)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          } satisfies ResponseOutputMessage);
        } else if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          const [callIdRaw, itemIdRaw] = toolCall.id.split("|");
          const callId = callIdRaw ?? toolCall.id;
          let itemId: string | undefined = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          });
        }
      }
      if (output.length === 0) continue;
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
      const hasText = textResult.length > 0;
      const [callIdRaw] = msg.toolCallId.split("|");
      const callId = callIdRaw ?? msg.toolCallId;

      let output: string | ResponseFunctionCallOutputItemList;
      if (hasImages && model.input.includes("image")) {
        const contentParts: ResponseFunctionCallOutputItemList = [];
        if (hasText) {
          contentParts.push({
            type: "input_text",
            text: sanitizeSurrogates(textResult),
          });
        }
        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }
        output = contentParts;
      } else {
        output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
      }

      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    msgIndex++;
  }

  return messages;
}
