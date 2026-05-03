import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "../types.js";
import { parseStreamingJson } from "../utils/json-parse.js";

interface ToolCallFolderState {
  contentIndex: number;
  block: ToolCall;
  partialJson: string;
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
  ) {}

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
    const block: ToolCall = {
      type: "toolCall",
      id: seed.id,
      name: seed.name,
      arguments:
        partialJson && partialJson.trim().length > 0
          ? parseStreamingJson(partialJson)
          : (seed.arguments ?? {}),
      ...(seed.thoughtSignature ? { thoughtSignature: seed.thoughtSignature } : {}),
    };
    this.output.content.push(block);
    const nextState: ToolCallFolderState = {
      contentIndex: this.output.content.length - 1,
      block,
      partialJson,
    };
    this.#states.set(key, nextState);
    this.#order.push(key);
    this.stream.push({
      type: "toolcall_start",
      contentIndex: nextState.contentIndex,
      partial: this.output,
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
      state.block.arguments = parseStreamingJson(state.partialJson);
    }
    this.stream.push({
      type: "toolcall_delta",
      contentIndex: state.contentIndex,
      delta,
      partial: this.output,
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
    state.block.arguments = parseStreamingJson(state.partialJson);
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
    state.block.arguments = parseStreamingJson(state.partialJson);
    this.output.content[state.contentIndex] = state.block;
    this.stream.push({
      type: "toolcall_end",
      contentIndex: state.contentIndex,
      toolCall: state.block,
      partial: this.output,
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
