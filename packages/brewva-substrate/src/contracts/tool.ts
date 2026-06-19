import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaOutcome } from "@brewva/brewva-vocabulary/outcome";
import type { Static, TSchema } from "@sinclair/typebox";
import type { BrewvaToolUiPort } from "../host-api/ui.js";
import type { BrewvaSourceInfo } from "./source-info.js";

export interface BrewvaTextContentPart {
  type: "text";
  text: string;
}

export interface BrewvaImageContentPart {
  type: "image";
  data: string;
  mimeType: string;
}

export type BrewvaToolContentPart = BrewvaTextContentPart | BrewvaImageContentPart;

export interface BrewvaToolResultDisplay {
  summaryText?: string;
  detailsText?: string;
  rawText?: string;
}

export interface BrewvaToolResult<TOutput = unknown, TError = unknown> {
  content: BrewvaToolContentPart[];
  outcome: BrewvaOutcome<TOutput, TError>;
  display?: BrewvaToolResultDisplay;
}

export interface BrewvaToolContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface BrewvaSessionManagerView {
  getSessionId(): string;
  getLeafId(): string | null;
}

export interface BrewvaCompactionRequest {
  customInstructions?: string;
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

export interface BrewvaToolContext {
  ui: BrewvaToolUiPort;
  hasUI: boolean;
  cwd: string;
  sessionManager: BrewvaSessionManagerView;
  modelRegistry: import("./provider.js").BrewvaModelCatalog;
  model: import("./provider.js").BrewvaRegisteredModel | undefined;
  isIdle(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  compact(request?: BrewvaCompactionRequest): void;
  getContextUsage(): BrewvaToolContextUsage | undefined;
  getSystemPrompt(): string;
}

export interface BrewvaToolRenderContext {
  toolCallId: string;
  args: unknown;
  cwd: string;
  state: unknown;
  invalidate(): void;
  lastComponent?: BrewvaRenderableComponent;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

export interface BrewvaRenderableComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
}

export interface BrewvaToolResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export type BrewvaToolUpdateHandler<TOutput = JsonValue, TError = JsonValue> = (
  update: BrewvaToolResult<TOutput, TError>,
) => Promise<void>;

export interface BrewvaToolDefinition<
  TParams extends TSchema = TSchema,
  TOutput = unknown,
  TError = unknown,
> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  outputSchema?: TSchema;
  errorSchema?: TSchema;
  outcomeVersion?: string;
  sourceInfo?: BrewvaSourceInfo;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: BrewvaToolUpdateHandler<TOutput, TError> | undefined,
    ctx: BrewvaToolContext,
  ): Promise<BrewvaToolResult<TOutput, TError>>;
  renderCall?(
    args: Static<TParams>,
    theme: unknown,
    ctx: BrewvaToolRenderContext,
  ): BrewvaRenderableComponent;
  renderResult?(
    result: BrewvaToolResult<TOutput, TError>,
    options: BrewvaToolResultRenderOptions,
    theme: unknown,
    ctx: BrewvaToolRenderContext,
  ): BrewvaRenderableComponent;
}

type AnyBrewvaToolDefinition = BrewvaToolDefinition;

export function defineBrewvaTool<TParams extends TSchema, TOutput = unknown, TError = unknown>(
  tool: BrewvaToolDefinition<TParams, TOutput, TError>,
): BrewvaToolDefinition<TParams, TOutput, TError> & AnyBrewvaToolDefinition {
  return tool;
}
