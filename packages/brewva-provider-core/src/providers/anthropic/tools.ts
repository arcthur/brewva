import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "../../contracts/index.js";
import { readSchemaProperties, readSchemaRequired } from "../_shared/tool-schema-bridge.js";
import { toClaudeCodeName } from "./compat.js";
import type { AnthropicCacheControl, AnthropicCacheControlAllocator } from "./contract.js";

export function convertTools(
  tools: Tool[],
  isOAuthToken: boolean,
  cacheControlAllocator?: AnthropicCacheControlAllocator,
): Anthropic.Messages.Tool[] {
  if (!tools) return [];

  const converted = tools.map((tool) => {
    return {
      name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: readSchemaProperties(tool.parameters),
        required: readSchemaRequired(tool.parameters),
      },
    };
  });
  const cacheControl = cacheControlAllocator?.claim();
  if (cacheControl && converted.length > 0) {
    const lastTool = converted[converted.length - 1];
    if (!lastTool) {
      return converted;
    }
    (lastTool as typeof lastTool & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
  }
  return converted;
}
