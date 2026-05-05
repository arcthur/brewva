import type { Tool as OpenAITool } from "openai/resources/responses/responses.js";
import type { Tool } from "../../contracts/index.js";
import { asJsonSchemaObject } from "../_shared/tool-schema-bridge.js";
import type { ConvertResponsesToolsOptions } from "./contract.js";

export function convertResponsesTools(
  tools: Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: asJsonSchemaObject(tool.parameters),
    strict,
  }));
}
