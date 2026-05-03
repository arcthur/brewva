import type { AssistantMessage, AssistantMessageEventStream } from "../types.js";
import { AssistantBlockAccumulator } from "./block-accumulator.js";
import { IncrementalToolCallFolder } from "./tool-call-folder.js";

export class ProviderStreamingComposer {
  readonly blocks: AssistantBlockAccumulator;
  readonly toolCalls: IncrementalToolCallFolder;

  constructor(
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    ensureStarted: () => void,
  ) {
    this.blocks = new AssistantBlockAccumulator(output, stream, ensureStarted);
    this.toolCalls = new IncrementalToolCallFolder(output, stream, ensureStarted);
  }

  finishAll(): void {
    this.blocks.finish();
    this.toolCalls.finalizeAll();
  }
}
