import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { BrewvaAgentEngineTool, BrewvaAgentEngineToolCall } from "./agent-engine-types.js";

declare const validatedToolArgumentsBrand: unique symbol;

export type BrewvaValidatedToolArguments = Record<string, unknown> & {
  readonly [validatedToolArgumentsBrand]: "BrewvaValidatedToolArguments";
};

export type BrewvaToolArgumentValidationResult =
  | {
      ok: true;
      args: BrewvaValidatedToolArguments;
    }
  | {
      ok: false;
      error: string;
    };

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

const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  "chrome" in globalThis &&
  Boolean((globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);

function canUseRuntimeCodegen(): boolean {
  return !isBrowserExtension;
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

export function prepareToolArguments(
  tool: BrewvaAgentEngineTool,
  toolCall: BrewvaAgentEngineToolCall,
): BrewvaAgentEngineToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, unknown>,
  };
}

export function validateToolArguments(
  tool: BrewvaAgentEngineTool,
  toolCall: BrewvaAgentEngineToolCall,
): BrewvaToolArgumentValidationResult {
  if (!ajv || !canUseRuntimeCodegen()) {
    return {
      ok: true,
      args: toolCall.arguments as BrewvaValidatedToolArguments,
    };
  }

  const validate = ajv.compile(tool.parameters);
  const args = structuredClone(toolCall.arguments);
  if (validate(args)) {
    return {
      ok: true,
      args: args as BrewvaValidatedToolArguments,
    };
  }

  const errors =
    validate.errors
      ?.map((error) => {
        const path = error.instancePath
          ? error.instancePath.substring(1)
          : ((error.params as { missingProperty?: string }).missingProperty ?? "root");
        return `  - ${path}: ${error.message}`;
      })
      .join("\n") ?? "Unknown validation error";

  return {
    ok: false,
    error: `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
  };
}
