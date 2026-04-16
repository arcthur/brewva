import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { Tool, ToolCall } from "../types.js";

declare const validatedProviderToolArgumentsBrand: unique symbol;

export type ProviderValidatedToolArguments = Record<string, unknown> & {
  readonly [validatedProviderToolArgumentsBrand]: "ProviderValidatedToolArguments";
};

export type ToolArgumentValidationResult =
  | {
      ok: true;
      args: ProviderValidatedToolArguments;
    }
  | {
      ok: false;
      error: string;
    };

export type ToolCallValidationResult = ToolArgumentValidationResult;

type ValidationError = {
  instancePath: string;
  message?: string;
  params: {
    missingProperty?: string;
  };
};

type ValidationResult = ((args: unknown) => boolean) & {
  errors?: ValidationError[];
};

type AjvLike = {
  compile(schema: unknown): ValidationResult;
};

type AjvConstructor = new (options: {
  allErrors: boolean;
  strict: boolean;
  coerceTypes: boolean;
}) => AjvLike;

type AddFormatsFunction = (ajv: AjvLike) => void;

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  Boolean((globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);

function canUseRuntimeCodegen(): boolean {
  if (isBrowserExtension) {
    return false;
  }

  try {
    new Function("return true;");
    return true;
  } catch {
    return false;
  }
}

let ajv: AjvLike | null = null;
if (canUseRuntimeCodegen()) {
  try {
    const Ajv = AjvModule as unknown as { default?: AjvConstructor } | AjvConstructor;
    const AjvCtor = (typeof Ajv === "function" ? Ajv : Ajv.default) as AjvConstructor;
    const addFormats = addFormatsModule as unknown as
      | { default?: AddFormatsFunction }
      | AddFormatsFunction;
    const addFormatsFn = (
      typeof addFormats === "function" ? addFormats : addFormats.default
    ) as AddFormatsFunction;
    ajv = new AjvCtor({
      allErrors: true,
      strict: false,
      coerceTypes: true,
    });
    addFormatsFn(ajv);
  } catch {
    ajv = null;
  }
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The explicit validation result
 */
export function validateToolCallResult(
  tools: Tool[],
  toolCall: ToolCall,
): ToolCallValidationResult {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      ok: false,
      error: `Tool "${toolCall.name}" not found`,
    };
  }
  return validateToolArgumentsResult(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The explicit validation result
 */
export function validateToolArgumentsResult(
  tool: Tool,
  toolCall: ToolCall,
): ToolArgumentValidationResult {
  if (!ajv || !canUseRuntimeCodegen()) {
    return {
      ok: true,
      args: toolCall.arguments as ProviderValidatedToolArguments,
    };
  }

  const validate = ajv.compile(tool.parameters);
  const args = structuredClone(toolCall.arguments);
  if (validate(args)) {
    return {
      ok: true,
      args: args as ProviderValidatedToolArguments,
    };
  }

  const errors =
    validate.errors
      ?.map((error) => {
        const path = error.instancePath
          ? error.instancePath.substring(1)
          : (error.params.missingProperty ?? "root");
        return `  - ${path}: ${error.message}`;
      })
      .join("\n") ?? "Unknown validation error";

  return {
    ok: false,
    error: `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
  };
}

export function validateToolCall(
  tools: Tool[],
  toolCall: ToolCall,
): ProviderValidatedToolArguments {
  const result = validateToolCallResult(tools, toolCall);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.args;
}

export function validateToolArguments(
  tool: Tool,
  toolCall: ToolCall,
): ProviderValidatedToolArguments {
  const result = validateToolArgumentsResult(tool, toolCall);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.args;
}
