import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  ProviderEventSink,
  ProviderStreamError,
  TextContent,
  ThinkingContent,
} from "../contracts/index.js";

type CurrentBlock = TextContent | ThinkingContent | null;

export class AssistantBlockAccumulator {
  #currentBlock: CurrentBlock = null;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: ProviderEventSink,
    private readonly ensureStarted: () => BrewvaEffect.Effect<void, ProviderStreamError>,
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
  ): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      const thinking = options.thinking === true;
      if (
        !self.#currentBlock ||
        (thinking && self.#currentBlock.type !== "thinking") ||
        (!thinking && self.#currentBlock.type !== "text")
      ) {
        yield* self.endCurrent();
        yield* self.ensureStarted();
        if (thinking) {
          self.#currentBlock = {
            type: "thinking",
            thinking: "",
            thinkingSignature: undefined,
          };
          self.output.content.push(self.#currentBlock);
          yield* self.stream.push({
            type: "thinking_start",
            contentIndex: self.blockIndex(),
            partial: self.output,
          });
        } else {
          self.#currentBlock = {
            type: "text",
            text: "",
            textSignature: undefined,
          };
          self.output.content.push(self.#currentBlock);
          yield* self.stream.push({
            type: "text_start",
            contentIndex: self.blockIndex(),
            partial: self.output,
          });
        }
      }

      if (self.#currentBlock.type === "thinking") {
        self.#currentBlock.thinking += text;
        if (options.signature) {
          self.#currentBlock.thinkingSignature = options.signature;
        }
        yield* self.stream.push({
          type: "thinking_delta",
          contentIndex: self.blockIndex(),
          delta: text,
          partial: self.output,
        });
        return;
      }

      self.#currentBlock.text += text;
      if (options.signature) {
        self.#currentBlock.textSignature = options.signature;
      }
      yield* self.stream.push({
        type: "text_delta",
        contentIndex: self.blockIndex(),
        delta: text,
        partial: self.output,
      });
    });
  }

  finish(): BrewvaEffect.Effect<void, ProviderStreamError> {
    return this.endCurrent();
  }

  private blockIndex(): number {
    return this.output.content.length - 1;
  }

  private endCurrent(): BrewvaEffect.Effect<void, ProviderStreamError> {
    const self = this;
    return BrewvaEffect.gen(function* () {
      if (!self.#currentBlock) {
        return;
      }
      if (self.#currentBlock.type === "thinking") {
        yield* self.stream.push({
          type: "thinking_end",
          contentIndex: self.blockIndex(),
          content: self.#currentBlock.thinking,
          partial: self.output,
        });
      } else {
        yield* self.stream.push({
          type: "text_end",
          contentIndex: self.blockIndex(),
          content: self.#currentBlock.text,
          partial: self.output,
        });
      }
      self.#currentBlock = null;
    });
  }
}
