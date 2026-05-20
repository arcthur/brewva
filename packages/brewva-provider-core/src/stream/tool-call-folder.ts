import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  ProviderEventSink,
  ProviderStreamError,
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
    private readonly stream: ProviderEventSink,
    private readonly ensureStarted: () => BrewvaEffect.Effect<void, ProviderStreamError>,
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

  begin(
    key: string,
    seed: ToolCallSeed,
    partialJson = "",
  ): BrewvaEffect.Effect<number, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const state = self.#states.get(key);
      if (state) {
        state.block.id = seed.id || state.block.id;
        state.block.name = seed.name || state.block.name;
        if (seed.thoughtSignature) {
          state.block.thoughtSignature = seed.thoughtSignature;
        }
        return state.contentIndex;
      }

      yield* self.ensureStarted();

      const parseResult = self.#parseSeedArguments(seed, partialJson);
      const block: ToolCall = {
        type: "toolCall",
        id: seed.id,
        name: seed.name,
        arguments: parseResult.output,
        ...(seed.thoughtSignature ? { thoughtSignature: seed.thoughtSignature } : {}),
      };
      self.output.content.push(block);
      const nextState: ToolCallFolderState = {
        contentIndex: self.output.content.length - 1,
        block,
        partialJson,
        lastParseStatus: parseResult.parseStatus,
      };
      self.#states.set(key, nextState);
      self.#order.push(key);
      yield* self.stream.push({
        type: "toolcall_start",
        contentIndex: nextState.contentIndex,
        partial: self.output,
        parseStatus: parseResult.parseStatus,
      });
      return nextState.contentIndex;
    });
  }

  appendArgumentsDelta(
    key: string,
    delta: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const state = self.#states.get(key);
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
          self.parseRegistry,
        );
        state.block.arguments = parseResult.output;
        state.lastParseStatus = parseResult.parseStatus;
      }
      yield* self.stream.push({
        type: "toolcall_delta",
        contentIndex: state.contentIndex,
        delta,
        partial: self.output,
        parseStatus: state.lastParseStatus,
      });
    });
  }

  replaceArguments(
    key: string,
    fullJson: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const state = self.#states.get(key);
      if (!state) {
        return;
      }
      const previousPartialJson = state.partialJson;
      state.partialJson = fullJson;
      const parseResult = parseStreamingJson(fullJson, state.block.name, self.parseRegistry);
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
        yield* self.stream.push({
          type: "toolcall_delta",
          contentIndex: state.contentIndex,
          delta,
          partial: self.output,
          parseStatus: parseResult.parseStatus,
        });
      }
    });
  }

  finalize(
    key: string,
    patch?: Partial<Pick<ToolCall, "id" | "name" | "thoughtSignature">>,
  ): BrewvaEffect.Effect<ToolCall | null, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const state = self.#states.get(key);
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
      const parseResult = self.#parseStateArguments(state);
      state.block.arguments = parseResult.output;
      self.output.content[state.contentIndex] = state.block;
      yield* self.stream.push({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall: state.block,
        partial: self.output,
        parseStatus: parseResult.parseStatus,
      });
      self.#states.delete(key);
      return state.block;
    });
  }

  finalizeAll(): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      for (const key of self.#order) {
        yield* self.finalize(key);
      }
    });
  }

  pushAtomic(toolCall: ToolCall, key: string): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const argumentsJson = JSON.stringify(toolCall.arguments ?? {});
      yield* self.begin(key, toolCall, argumentsJson);
      yield* self.appendArgumentsDelta(key, argumentsJson, toolCall);
      yield* self.finalize(key, toolCall);
    });
  }
}
