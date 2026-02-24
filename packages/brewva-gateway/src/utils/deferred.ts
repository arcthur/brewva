export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveValue!: (value: T) => void;
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
