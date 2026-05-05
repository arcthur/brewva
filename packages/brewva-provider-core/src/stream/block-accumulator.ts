import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
} from "../contracts/index.js";

type CurrentBlock = TextContent | ThinkingContent | null;

export class AssistantBlockAccumulator {
  #currentBlock: CurrentBlock = null;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
    private readonly ensureStarted: () => void,
  ) {}

  get hasContent(): boolean {
    return this.output.content.length > 0;
  }

  appendText(
    text: string,
    options: {
      thinking?: boolean;
      signature?: string;
    } = {},
  ): void {
    const thinking = options.thinking === true;
    if (
      !this.#currentBlock ||
      (thinking && this.#currentBlock.type !== "thinking") ||
      (!thinking && this.#currentBlock.type !== "text")
    ) {
      this.endCurrent();
      this.ensureStarted();
      if (thinking) {
        this.#currentBlock = {
          type: "thinking",
          thinking: "",
          thinkingSignature: undefined,
        };
        this.output.content.push(this.#currentBlock);
        this.stream.push({
          type: "thinking_start",
          contentIndex: this.blockIndex(),
          partial: this.output,
        });
      } else {
        this.#currentBlock = {
          type: "text",
          text: "",
          textSignature: undefined,
        };
        this.output.content.push(this.#currentBlock);
        this.stream.push({
          type: "text_start",
          contentIndex: this.blockIndex(),
          partial: this.output,
        });
      }
    }

    if (this.#currentBlock.type === "thinking") {
      this.#currentBlock.thinking += text;
      if (options.signature) {
        this.#currentBlock.thinkingSignature = options.signature;
      }
      this.stream.push({
        type: "thinking_delta",
        contentIndex: this.blockIndex(),
        delta: text,
        partial: this.output,
      });
      return;
    }

    this.#currentBlock.text += text;
    if (options.signature) {
      this.#currentBlock.textSignature = options.signature;
    }
    this.stream.push({
      type: "text_delta",
      contentIndex: this.blockIndex(),
      delta: text,
      partial: this.output,
    });
  }

  finish(): void {
    this.endCurrent();
  }

  private blockIndex(): number {
    return this.output.content.length - 1;
  }

  private endCurrent(): void {
    if (!this.#currentBlock) {
      return;
    }
    if (this.#currentBlock.type === "thinking") {
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.blockIndex(),
        content: this.#currentBlock.thinking,
        partial: this.output,
      });
    } else {
      this.stream.push({
        type: "text_end",
        contentIndex: this.blockIndex(),
        content: this.#currentBlock.text,
        partial: this.output,
      });
    }
    this.#currentBlock = null;
  }
}
