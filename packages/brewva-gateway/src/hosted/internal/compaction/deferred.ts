import type { BrewvaCompactionRequest } from "@brewva/brewva-substrate/tools";
import type { ManagedSessionCompactionFlowState, PendingCompactionRequestState } from "./flow.js";

export type DeferredCompactionSalvageMode = "persisted-preview" | "settled-compaction";

export interface ManagedSessionDeferredCompactionCoordinatorOptions<Prepared, Built> {
  flow: ManagedSessionCompactionFlowState;
  isStreaming: () => boolean;
  preview: (request: PendingCompactionRequestState) => Promise<Prepared>;
  build: (prepared: Prepared) => Built;
  finalize: (prepared: Prepared, built: Built) => Promise<void>;
  salvage: (
    prepared: Prepared,
    built: Built,
    mode: DeferredCompactionSalvageMode,
  ) => Promise<boolean>;
  rollback: (prepared: Prepared) => Promise<void>;
}

export class ManagedSessionDeferredCompactionCoordinator<Prepared, Built> {
  readonly #flow: ManagedSessionCompactionFlowState;
  readonly #isStreaming: ManagedSessionDeferredCompactionCoordinatorOptions<
    Prepared,
    Built
  >["isStreaming"];
  readonly #preview: ManagedSessionDeferredCompactionCoordinatorOptions<Prepared, Built>["preview"];
  readonly #build: ManagedSessionDeferredCompactionCoordinatorOptions<Prepared, Built>["build"];
  readonly #finalize: ManagedSessionDeferredCompactionCoordinatorOptions<
    Prepared,
    Built
  >["finalize"];
  readonly #salvage: ManagedSessionDeferredCompactionCoordinatorOptions<Prepared, Built>["salvage"];
  readonly #rollback: ManagedSessionDeferredCompactionCoordinatorOptions<
    Prepared,
    Built
  >["rollback"];

  constructor(options: ManagedSessionDeferredCompactionCoordinatorOptions<Prepared, Built>) {
    this.#flow = options.flow;
    this.#isStreaming = options.isStreaming;
    this.#preview = options.preview;
    this.#build = options.build;
    this.#finalize = options.finalize;
    this.#salvage = options.salvage;
    this.#rollback = options.rollback;
  }

  get isCompacting(): boolean {
    return this.#flow.isCompacting;
  }

  request(request?: BrewvaCompactionRequest): Promise<void> | void {
    const shouldExecuteImmediately = this.#flow.requestCompaction(this.#isStreaming(), request);
    if (!shouldExecuteImmediately) {
      return;
    }
    return this.flushAfterCommittedToolResult().then(() => undefined);
  }

  consumeToolResultStop(): boolean {
    return this.#flow.consumeToolResultStop();
  }

  async settleTurnEnd(): Promise<void> {
    this.#flow.clearStopAfterCurrentToolResults();
    await this.flushAfterCommittedToolResult();
  }

  async flushAfterCommittedToolResult(): Promise<boolean> {
    const request = this.#flow.beginDeferredCompaction();
    if (!request) {
      return false;
    }
    let prepared: Prepared | null = null;
    let built: Built | null = null;
    try {
      prepared = await this.#preview(request);
      built = this.#build(prepared);
      try {
        await this.#finalize(prepared, built);
        return true;
      } catch (error) {
        if (await this.#salvage(prepared, built, "persisted-preview")) {
          return true;
        }
        await this.#rollback(prepared);
        throw error;
      }
    } catch (error) {
      this.#flow.clearStopAfterCurrentToolResults();
      if (prepared && built) {
        if (await this.#salvage(prepared, built, "settled-compaction")) {
          return true;
        }
      }
      request.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      this.#flow.finishDeferredCompaction();
    }
  }
}
