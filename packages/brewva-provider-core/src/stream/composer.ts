import type { AssistantMessage, AssistantMessageEventStream } from "../contracts/index.js";
import type { StreamingParseRegistry } from "../parse/types.js";
import { AssistantBlockAccumulator } from "./block-accumulator.js";
import { IncrementalToolCallFolder } from "./tool-call-folder.js";

export class ProviderStreamingComposer {
  readonly blocks: AssistantBlockAccumulator;
  readonly toolCalls: IncrementalToolCallFolder;

  constructor(
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    ensureStarted: () => void,
    parseRegistry?: StreamingParseRegistry,
  ) {
    this.blocks = new AssistantBlockAccumulator(output, stream, ensureStarted);
    this.toolCalls = new IncrementalToolCallFolder(output, stream, ensureStarted, parseRegistry);
  }

  finishAll(): void {
    this.blocks.finish();
    this.toolCalls.finalizeAll();
  }
}
