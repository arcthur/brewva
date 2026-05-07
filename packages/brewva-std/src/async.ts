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

function normalizeConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("concurrency must be a positive integer");
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
