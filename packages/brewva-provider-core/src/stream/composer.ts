import type { AssistantMessage, ProviderEventSink } from "../contracts/index.js";
import type { StreamingParseRegistry } from "../parse/types.js";
import { AssistantBlockAccumulator } from "./block-accumulator.js";
import { IncrementalToolCallFolder } from "./tool-call-folder.js";

export class ProviderStreamingComposer {
  readonly blocks: AssistantBlockAccumulator;
  readonly toolCalls: IncrementalToolCallFolder;

  constructor(
    output: AssistantMessage,
    stream: ProviderEventSink,
    ensureStarted: () => Promise<void>,
    parseRegistry?: StreamingParseRegistry,
  ) {
    this.blocks = new AssistantBlockAccumulator(output, stream, ensureStarted);
    this.toolCalls = new IncrementalToolCallFolder(output, stream, ensureStarted, parseRegistry);
  }

  async finishAll(): Promise<void> {
    await this.blocks.finish();
    await this.toolCalls.finalizeAll();
  }
}
