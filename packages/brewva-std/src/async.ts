import pLimit from "p-limit";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
}

export interface NonOverlappingTaskRunner {
  run: () => Promise<boolean>;
  whenIdle: () => Promise<void>;
}

export interface ConcurrencyLimiter {
  run: <T>(task: () => T | PromiseLike<T>) => Promise<T>;
  map: <TInput, TOutput>(
    items: Iterable<TInput>,
    mapper: (item: TInput, index: number) => TOutput | PromiseLike<TOutput>,
  ) => Promise<TOutput[]>;
  activeCount: () => number;
  pendingCount: () => number;
  clearQueue: () => void;
  concurrency: () => number;
  setConcurrency: (value: number) => void;
}

export interface ConcurrencyLimiterOptions {
  concurrency: number;
  rejectOnClear?: boolean;
}

export interface MapConcurrentOptions {
  concurrency: number;
}

export interface AsyncBridge<T> extends AsyncIterable<T> {
  write: (item: T) => Promise<void>;
  close: () => void;
  fail: (error: unknown) => void;
  abort: (reason?: unknown) => void;
}

export interface AsyncBridgeOptions {
  capacity?: number;
  onCancel?: () => void | Promise<void>;
}

export function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = (): void => {
    target.abort(source.reason);
  };
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) {
    abort();
  }
  return () => source.removeEventListener("abort", abort);
}

interface PendingAsyncBridgeReader<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

interface PendingAsyncBridgeWriter<T> {
  item: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class AsyncBridgeClosedError extends Error {
  constructor() {
    super("async_bridge_closed");
    this.name = "AsyncBridgeClosedError";
  }
}

export class AsyncBridgeAbortedError extends Error {
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : "async_bridge_aborted");
    this.name = "AsyncBridgeAbortedError";
  }
}

function normalizeConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  return value;
}

function normalizeAsyncBridgeCapacity(value: number | undefined): number {
  if (value === undefined) {
    return 64;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("capacity must be a positive integer");
  }
  return value;
}

export function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveValue!: (value: T | PromiseLike<T>) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    rejectValue = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
    settled: () => settled,
  };
}

export function createNonOverlappingTaskRunner(
  task: () => void | PromiseLike<void>,
): NonOverlappingTaskRunner {
  let inFlight: Promise<void> | null = null;

  return {
    async run(): Promise<boolean> {
      if (inFlight) {
        return false;
      }
      const current = new Promise<void>((resolve, reject) => {
        try {
          Promise.resolve(task()).then(() => resolve(), reject);
        } catch (error) {
          reject(error);
        }
      }).finally(() => {
        if (inFlight === current) {
          inFlight = null;
        }
      });
      inFlight = current;
      await current;
      return true;
    },
    async whenIdle(): Promise<void> {
      await inFlight?.catch(() => undefined);
    },
  };
}

export function createAsyncBridge<T>(options: AsyncBridgeOptions = {}): AsyncBridge<T> {
  const capacity = normalizeAsyncBridgeCapacity(options.capacity);
  const queue: T[] = [];
  const readers: PendingAsyncBridgeReader<T>[] = [];
  const writers: PendingAsyncBridgeWriter<T>[] = [];
  let closed = false;
  let failed: unknown;
  let cancelled = false;

  const closeError = () => new AsyncBridgeClosedError();

  const rejectPendingWriters = (error: unknown): void => {
    while (writers.length > 0) {
      writers.shift()?.reject(error);
    }
  };

  const settleClosedReaders = (): void => {
    if (!closed || queue.length > 0) {
      return;
    }
    while (readers.length > 0) {
      readers.shift()?.resolve({ done: true, value: undefined });
    }
  };

  const flushReaders = (): void => {
    while (readers.length > 0 && queue.length > 0) {
      const item = queue.shift() as T;
      readers.shift()?.resolve({ done: false, value: item });
    }
  };

  const pump = (): void => {
    flushReaders();
    if (!closed && failed === undefined) {
      while (writers.length > 0 && queue.length < capacity) {
        const writer = writers.shift();
        if (!writer) {
          break;
        }
        if (readers.length > 0 && queue.length === 0) {
          readers.shift()?.resolve({ done: false, value: writer.item });
        } else {
          queue.push(writer.item);
        }
        writer.resolve();
      }
    }
    settleClosedReaders();
  };

  const terminate = (error: unknown): void => {
    if (failed !== undefined) {
      return;
    }
    failed = error;
    queue.length = 0;
    rejectPendingWriters(error);
    while (readers.length > 0) {
      readers.shift()?.reject(error);
    }
  };

  const runCancel = async (): Promise<void> => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    await options.onCancel?.();
  };

  return {
    write(item: T): Promise<void> {
      if (failed !== undefined) {
        return Promise.reject(failed);
      }
      if (closed) {
        return Promise.reject(closeError());
      }
      if (readers.length > 0 && queue.length === 0) {
        readers.shift()?.resolve({ done: false, value: item });
        return Promise.resolve();
      }
      if (queue.length < capacity) {
        queue.push(item);
        pump();
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        writers.push({ item, resolve, reject });
      });
    },
    close(): void {
      if (closed || failed !== undefined) {
        return;
      }
      closed = true;
      rejectPendingWriters(closeError());
      pump();
    },
    fail(error: unknown): void {
      terminate(error);
    },
    abort(reason?: unknown): void {
      terminate(new AsyncBridgeAbortedError(reason));
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            const item = queue.shift() as T;
            pump();
            return Promise.resolve({ done: false, value: item });
          }
          if (failed !== undefined) {
            return Promise.reject(failed);
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            readers.push({ resolve, reject });
          });
        },
        async return(): Promise<IteratorResult<T>> {
          if (!closed && failed === undefined) {
            closed = true;
            queue.length = 0;
            rejectPendingWriters(closeError());
            settleClosedReaders();
          }
          await runCancel();
          return { done: true, value: undefined };
        },
        throw(error?: unknown): Promise<IteratorResult<T>> {
          terminate(error);
          return Promise.reject(error);
        },
      };
    },
  };
}

export function createConcurrencyLimiter(options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  const limit = pLimit({
    concurrency: normalizeConcurrency(options.concurrency),
    rejectOnClear: options.rejectOnClear ?? false,
  });

  return {
    run<T>(task: () => T | PromiseLike<T>): Promise<T> {
      return limit(task);
    },
    map<TInput, TOutput>(
      items: Iterable<TInput>,
      mapper: (item: TInput, index: number) => TOutput | PromiseLike<TOutput>,
    ): Promise<TOutput[]> {
      return limit.map(items, mapper);
    },
    activeCount(): number {
      return limit.activeCount;
    },
    pendingCount(): number {
      return limit.pendingCount;
    },
    clearQueue(): void {
      limit.clearQueue();
    },
    concurrency(): number {
      return limit.concurrency;
    },
    setConcurrency(value: number): void {
      limit.concurrency = normalizeConcurrency(value);
    },
  };
}

export async function mapConcurrent<TInput, TOutput>(
  items: readonly TInput[],
  options: MapConcurrentOptions,
  mapper: (item: TInput, index: number) => TOutput | PromiseLike<TOutput>,
): Promise<TOutput[]> {
  const limiter = createConcurrencyLimiter({ concurrency: options.concurrency });
  return Promise.all(items.map((item, index) => limiter.run(() => mapper(item, index))));
}
