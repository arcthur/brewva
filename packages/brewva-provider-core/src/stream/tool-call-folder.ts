import type {
  AssistantMessage,
  AssistantMessageEventStream,
  StreamingParseStatus,
  ToolCall,
} from "../contracts/index.js";
import { parseStreamingJson } from "../parse/json-parse.js";
import type { StreamingParseRegistry } from "../parse/types.js";

interface ToolCallFolderState {
  contentIndex: number;
  block: ToolCall;
  partialJson: string;
  lastParseStatus?: StreamingParseStatus;
}

export interface ToolCallSeed {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  thoughtSignature?: string;
}

export class IncrementalToolCallFolder {
  readonly #states = new Map<string, ToolCallFolderState>();
  readonly #order: string[] = [];

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
    private readonly ensureStarted: () => void,
    private readonly parseRegistry?: StreamingParseRegistry,
  ) {}

  #parseSeedArguments(seed: ToolCallSeed, partialJson: string) {
    if (partialJson.trim().length > 0) {
      return parseStreamingJson(partialJson, seed.name, this.parseRegistry);
    }
    if (seed.arguments) {
      return parseStreamingJson(JSON.stringify(seed.arguments), seed.name, this.parseRegistry);
    }
    return parseStreamingJson(undefined, seed.name, this.parseRegistry);
  }

  #parseStateArguments(state: ToolCallFolderState) {
    if (state.partialJson.trim().length > 0) {
      return parseStreamingJson(state.partialJson, state.block.name, this.parseRegistry);
    }
    return parseStreamingJson(
      JSON.stringify(state.block.arguments ?? {}),
      state.block.name,
      this.parseRegistry,
    );
  }

  begin(key: string, seed: ToolCallSeed, partialJson = ""): number {
    const state = this.#states.get(key);
    if (state) {
      state.block.id = seed.id || state.block.id;
      state.block.name = seed.name || state.block.name;
      if (seed.thoughtSignature) {
        state.block.thoughtSignature = seed.thoughtSignature;
      }
      return state.contentIndex;
    }

    this.ensureStarted();

    const parseResult = this.#parseSeedArguments(seed, partialJson);
    const block: ToolCall = {
      type: "toolCall",
      id: seed.id,
      name: seed.name,
      arguments: parseResult.output,
      ...(seed.thoughtSignature ? { thoughtSignature: seed.thoughtSignature } : {}),
    };
    this.output.content.push(block);
    const nextState: ToolCallFolderState = {
      contentIndex: this.output.content.length - 1,
      block,
      partialJson,
      lastParseStatus: parseResult.parseStatus,
    };
    this.#states.set(key, nextState);
    this.#order.push(key);
    this.stream.push({
      type: "toolcall_start",
      contentIndex: nextState.contentIndex,
      partial: this.output,
      parseStatus: parseResult.parseStatus,
    });
    return nextState.contentIndex;
  }

  appendArgumentsDelta(
    key: string,
    delta: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): void {
    const state = this.#states.get(key);
    if (!state) {
      return;
    }
    if (patch?.id) {
      state.block.id = patch.id;
    }
    if (patch?.name) {
      state.block.name = patch.name;
    }
    if (patch?.thoughtSignature) {
      state.block.thoughtSignature = patch.thoughtSignature;
    }
    if (delta.length > 0) {
      state.partialJson += delta;
      const parseResult = parseStreamingJson(
        state.partialJson,
        state.block.name,
        this.parseRegistry,
      );
      state.block.arguments = parseResult.output;
      state.lastParseStatus = parseResult.parseStatus;
    }
    this.stream.push({
      type: "toolcall_delta",
      contentIndex: state.contentIndex,
      delta,
      partial: this.output,
      parseStatus: state.lastParseStatus,
    });
  }

  replaceArguments(
    key: string,
    fullJson: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): void {
    const state = this.#states.get(key);
    if (!state) {
      return;
    }
    const previousPartialJson = state.partialJson;
    state.partialJson = fullJson;
    const parseResult = parseStreamingJson(fullJson, state.block.name, this.parseRegistry);
    state.block.arguments = parseResult.output;
    state.lastParseStatus = parseResult.parseStatus;
    if (patch?.id) {
      state.block.id = patch.id;
    }
    if (patch?.name) {
      state.block.name = patch.name;
    }
    if (patch?.thoughtSignature) {
      state.block.thoughtSignature = patch.thoughtSignature;
    }
    const delta = fullJson.startsWith(previousPartialJson)
      ? fullJson.slice(previousPartialJson.length)
      : "";
    if (delta.length > 0) {
      this.stream.push({
        type: "toolcall_delta",
        contentIndex: state.contentIndex,
        delta,
        partial: this.output,
        parseStatus: parseResult.parseStatus,
      });
    }
  }

  finalize(
    key: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): ToolCall | null {
    const state = this.#states.get(key);
    if (!state) {
      return null;
    }
    if (patch?.id) {
      state.block.id = patch.id;
    }
    if (patch?.name) {
      state.block.name = patch.name;
    }
    if (patch?.thoughtSignature) {
      state.block.thoughtSignature = patch.thoughtSignature;
    }
    const parseResult = this.#parseStateArguments(state);
    state.block.arguments = parseResult.output;
    this.output.content[state.contentIndex] = state.block;
    this.stream.push({
      type: "toolcall_end",
      contentIndex: state.contentIndex,
      toolCall: state.block,
      partial: this.output,
      parseStatus: parseResult.parseStatus,
    });
    this.#states.delete(key);
    return state.block;
  }

  finalizeAll(): void {
    for (const key of this.#order) {
      this.finalize(key);
    }
  }

  pushAtomic(toolCall: ToolCall, key: string): void {
    const argumentsJson = JSON.stringify(toolCall.arguments ?? {});
    this.begin(key, toolCall, argumentsJson);
    this.appendArgumentsDelta(key, argumentsJson, toolCall);
    this.finalize(key, toolCall);
  }
}
