import type {
  BrewvaToolContext,
  BrewvaToolDefinition,
  BrewvaToolResult,
  BrewvaToolUpdateHandler,
} from "../contracts/tool.js";

export interface BrewvaToolInvocation<TParams = unknown> {
  tool: BrewvaToolDefinition;
  toolCallId: string;
  params: TParams;
  signal: AbortSignal | undefined;
  onUpdate: BrewvaToolUpdateHandler | undefined;
  ctx: BrewvaToolContext;
}

export interface BrewvaToolInvocationResult<
  TParams = unknown,
  TOutput = unknown,
  TError = unknown,
> extends BrewvaToolInvocation<TParams> {
  result: BrewvaToolResult<TOutput, TError>;
}

export interface BrewvaToolInvocationError<
  TParams = unknown,
> extends BrewvaToolInvocation<TParams> {
  error: unknown;
}

export interface BrewvaToolWrapper<TParams = unknown, TOutput = unknown, TError = unknown> {
  before?(input: BrewvaToolInvocation<TParams>): void | Promise<void>;
  after?(input: BrewvaToolInvocationResult<TParams, TOutput, TError>): void | Promise<void>;
  onError?(
    input: BrewvaToolInvocationError<TParams>,
  ):
    | BrewvaToolResult<TOutput, TError>
    | undefined
    | Promise<BrewvaToolResult<TOutput, TError> | undefined>;
}

const TOOL_DEFINITION_KEYS = new Set<PropertyKey>([
  "name",
  "label",
  "description",
  "parameters",
  "outputSchema",
  "errorSchema",
  "outcomeVersion",
  "sourceInfo",
  "promptSnippet",
  "promptGuidelines",
  "prepareArguments",
  "execute",
  "renderCall",
  "renderResult",
]);

function copyMetadataDescriptors(source: object, target: object): void {
  for (const key of Reflect.ownKeys(source)) {
    if (TOOL_DEFINITION_KEYS.has(key) || Reflect.has(target, key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    }
  }
}

type BrewvaToolDefinitionParams<TTool extends BrewvaToolDefinition> = Parameters<
  TTool["execute"]
>[1];

type BrewvaToolDefinitionResult<TTool extends BrewvaToolDefinition> = Awaited<
  ReturnType<TTool["execute"]>
>;

type BrewvaToolDefinitionOutput<TTool extends BrewvaToolDefinition> =
  BrewvaToolDefinitionResult<TTool> extends BrewvaToolResult<infer TOutput, infer _TError>
    ? TOutput
    : unknown;

type BrewvaToolDefinitionError<TTool extends BrewvaToolDefinition> =
  BrewvaToolDefinitionResult<TTool> extends BrewvaToolResult<infer _TOutput, infer TError>
    ? TError
    : unknown;

export function wrapBrewvaTool<TTool extends BrewvaToolDefinition>(
  tool: TTool,
  wrapper: BrewvaToolWrapper<
    BrewvaToolDefinitionParams<TTool>,
    BrewvaToolDefinitionOutput<TTool>,
    BrewvaToolDefinitionError<TTool>
  >,
): TTool {
  const wrapped = {
    ...tool,
    async execute(
      ...args: Parameters<TTool["execute"]>
    ): Promise<BrewvaToolDefinitionResult<TTool>> {
      const [toolCallId, params, signal, onUpdate, ctx] = args;
      const invocation = {
        tool,
        toolCallId,
        params,
        signal,
        onUpdate: onUpdate as BrewvaToolUpdateHandler | undefined,
        ctx,
      };
      await wrapper.before?.(invocation);
      try {
        const result = (await tool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        )) as BrewvaToolDefinitionResult<TTool>;
        await wrapper.after?.({
          ...invocation,
          result: result as BrewvaToolResult<
            BrewvaToolDefinitionOutput<TTool>,
            BrewvaToolDefinitionError<TTool>
          >,
        });
        return result;
      } catch (error) {
        const fallback = await wrapper.onError?.({ ...invocation, error });
        if (fallback) {
          return fallback as BrewvaToolDefinitionResult<TTool>;
        }
        throw error;
      }
    },
  } as TTool;

  copyMetadataDescriptors(tool, wrapped);
  return wrapped;
}
