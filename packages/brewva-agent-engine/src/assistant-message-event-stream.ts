import type {
  BrewvaAgentEngineAssistantMessage,
  BrewvaAgentEngineAssistantMessageEvent,
  BrewvaAssistantMessageEventStream,
} from "./agent-engine-types.js";

export class EventStream<TEvent, TResult = TEvent> implements AsyncIterable<TEvent> {
  readonly #queue: TEvent[] = [];
  readonly #waiting: Array<(value: IteratorResult<TEvent>) => void> = [];
  readonly #result: Promise<TResult>;
  #done = false;
  #resolveResult!: (result: TResult) => void;

  constructor(
    private readonly isComplete: (event: TEvent) => boolean,
    private readonly extractResult: (event: TEvent) => TResult,
  ) {
    this.#result = new Promise<TResult>((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  push(event: TEvent): void {
    if (this.#done) {
      return;
    }

    if (this.isComplete(event)) {
      this.#done = true;
      this.#resolveResult(this.extractResult(event));
    }

    const waiter = this.#waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  end(result?: TResult): void {
    this.#done = true;
    if (result !== undefined) {
      this.#resolveResult(result);
    }
    while (this.#waiting.length > 0) {
      const waiter = this.#waiting.shift();
      waiter?.({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift() as TEvent;
        continue;
      }
      if (this.#done) {
        return;
      }
      const result = await new Promise<IteratorResult<TEvent>>((resolve) => {
        this.#waiting.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  result(): Promise<TResult> {
    return this.#result;
  }
}

export class AssistantMessageEventStream
  extends EventStream<BrewvaAgentEngineAssistantMessageEvent, BrewvaAgentEngineAssistantMessage>
  implements BrewvaAssistantMessageEventStream
{
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        }
        if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected assistant message event");
      },
    );
  }
}
