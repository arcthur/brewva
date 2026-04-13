import type { Static, TSchema } from "@sinclair/typebox";
import type { BrewvaToolUiPort } from "../host-api/ui.js";

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

export interface BrewvaToolResult<TDetails = unknown> {
  content: BrewvaToolContentPart[];
  details: TDetails;
  isError?: boolean;
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

export type BrewvaToolUpdateHandler<TDetails = unknown> = (
  update: BrewvaToolResult<TDetails>,
) => void;

export interface BrewvaToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: BrewvaToolUpdateHandler<TDetails> | undefined,
    ctx: BrewvaToolContext,
  ): Promise<BrewvaToolResult<TDetails>>;
  renderCall?(
    args: Static<TParams>,
    theme: unknown,
    ctx: BrewvaToolRenderContext,
  ): BrewvaRenderableComponent;
  renderResult?(
    result: BrewvaToolResult<TDetails>,
    options: BrewvaToolResultRenderOptions,
    theme: unknown,
    ctx: BrewvaToolRenderContext,
  ): BrewvaRenderableComponent;
}

type AnyBrewvaToolDefinition = BrewvaToolDefinition;

export function defineBrewvaTool<TParams extends TSchema, TDetails = unknown>(
  tool: BrewvaToolDefinition<TParams, TDetails>,
): BrewvaToolDefinition<TParams, TDetails> & AnyBrewvaToolDefinition {
  return tool;
}
