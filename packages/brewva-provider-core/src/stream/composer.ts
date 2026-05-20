import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  ProviderEventSink,
  ProviderStreamError,
} from "../contracts/index.js";
import type { StreamingParseRegistry } from "../parse/types.js";
import { AssistantBlockAccumulator } from "./block-accumulator.js";
import { IncrementalToolCallFolder } from "./tool-call-folder.js";

export class ProviderStreamingComposer {
  readonly blocks: AssistantBlockAccumulator;
  readonly toolCalls: IncrementalToolCallFolder;

  constructor(
    output: AssistantMessage,
    stream: ProviderEventSink,
    ensureStarted: () => BrewvaEffect.Effect<void, ProviderStreamError>,
    parseRegistry?: StreamingParseRegistry,
  ) {
    this.blocks = new AssistantBlockAccumulator(output, stream, ensureStarted);
    this.toolCalls = new IncrementalToolCallFolder(output, stream, ensureStarted, parseRegistry);
  }

  finishAll(): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      yield* self.blocks.finish();
      yield* self.toolCalls.finalizeAll();
    });
  }
}
